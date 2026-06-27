/**
 * Dashboard: arrows browse the agent list; typing drives the command menu. The bar runs the editor's
 * own autocomplete in bare-command mode — any letter opens the menu, Tab completes to /command, a
 * single Enter runs it, unknown input errors.
 *
 * Beyond `new`/`quit`, the bar surfaces the auth + model commands (`model`, `thinking`, `login`,
 * `logout`). Unlike their in-session counterparts, these operate on the GLOBAL credential + settings
 * tier in-process, so every change persists as the shared default that agents inherit rather than
 * into one agent's storage.
 */

import {
  type Api,
  getSupportedThinkingLevels,
  type Model,
  type OAuthLoginCallbacks,
  type OAuthProviderId,
  type OAuthSelectPrompt,
} from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@opsyhq/agent";
import {
  type Agent,
  AuthStorage,
  DEFAULT_THINKING_LEVEL,
  findExactModelReferenceMatch,
  getDefaultModel,
  getDefaultProvider,
  getDefaultThinkingLevel,
  getEditorTheme,
  getSelectListTheme,
  HOME_SLASH_COMMANDS,
  isApiKeyLoginProvider,
  isDeployed,
  ModelRegistry,
  openBrowser,
  rawKeyHint,
  setSharedDefaultModel,
  setSharedDefaultThinkingLevel,
  theme,
  THINKING_LEVELS,
} from "@opsyhq/steward";
import {
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  Box,
  type Component,
  Container,
  type Focusable,
  fuzzyFilter,
  Input,
  matchesKey,
  type OverlayHandle,
  type SelectItem,
  SelectList,
  Spacer,
  Text,
} from "@opsyhq/tui";
import type { KeybindingsManager } from "../../../keybindings-manager.ts";
import { type AppView, BIRTH_OPENER, type ViewContext } from "../app.ts";
import { CustomEditor } from "./components/custom-editor.ts";
import { ExtensionInputComponent } from "./components/extension-input.ts";
import { ExtensionSelectorComponent } from "./components/extension-selector.ts";
import { ModelSelectorComponent } from "./components/model-selector.ts";
import { ThinkingSelectorComponent } from "./components/thinking-selector.ts";

export class DashboardView extends Container implements AppView {
  private ctx!: ViewContext;
  private readonly keybindings: KeybindingsManager;
  private readonly headerContainer = new Container();
  private readonly bodyContainer = new Container();
  private readonly editorContainer = new Container();
  private readonly statusContainer = new Container();
  private readonly footerContainer = new Container();
  private editor!: CustomEditor;
  private list?: SelectList;
  private overlay?: OverlayHandle;
  // Auth + model selection on the dashboard operate on GLOBAL storage in-process (no agent/daemon):
  // the global credential tier (~/.steward/agent/auth.json) and a registry over it. Everything the
  // selectors persist lands in the shared defaults, the fallback every agent inherits.
  private globalAuth!: AuthStorage;
  private registry!: ModelRegistry;

  constructor(keybindings: KeybindingsManager) {
    super();
    this.keybindings = keybindings;
  }

  onMount(ctx: ViewContext): void {
    this.ctx = ctx;
    this.globalAuth = AuthStorage.create();
    this.registry = ModelRegistry.create(this.globalAuth);

    // Focus the bar by hand (the view is the focus target). Bare-command mode (prefix "") lets the
    // editor's own autocomplete drive the menu without a leading slash.
    this.editor = new CustomEditor(ctx.tui, getEditorTheme(), this.keybindings, {
      paddingX: 1,
      commandMenuPrefix: "",
    });
    this.editor.focused = true;
    this.editor.setAutocompleteProvider(new HomeCommandProvider());
    this.editor.onEscape = () => this.editor.setText("");
    this.editor.onChange = () => {
      this.statusContainer.clear();
      this.renderFooter();
    };
    this.editor.onSubmit = (text) => this.runCommand(text);

    // Mounted for invalidation only; render() composes them with a bottom-pinning filler.
    this.addChild(this.headerContainer);
    this.addChild(this.bodyContainer);
    this.addChild(this.editorContainer);
    this.addChild(this.statusContainer);
    this.addChild(this.footerContainer);
    this.editorContainer.addChild(this.editor);

    this.renderHeader();
    this.renderBody();
    this.renderFooter();
  }

  /** Empty bar: the arrows browse the agent list. Otherwise the bar owns input and drives the menu. */
  private isBrowsing(): boolean {
    return this.editor.getText().trim() === "";
  }

  private renderHeader(): void {
    this.headerContainer.clear();
    this.headerContainer.addChild(new Text(theme.bold("Agents"), 1, 0));
  }

  private renderBody(): void {
    this.bodyContainer.clear();
    const agents = this.ctx.steward.list();
    if (agents.length === 0) {
      this.list = undefined;
      this.bodyContainer.addChild(
        new Text(theme.fg("dim", "No agents yet — type new to create your first one."), 1, 0),
      );
      return;
    }
    const items: SelectItem[] = agents.map((agent) => ({
      value: agent.name,
      label: `${isDeployed(agent.config) ? theme.fg("success", "●") : theme.fg("dim", "○")} ${agent.name}`,
      description: agent.config.purpose.trim().replace(/\s+/g, " "),
    }));
    this.list = new SelectList(items, 12, getSelectListTheme());
    this.list.onSelect = (item) => void this.ctx.navigate({ to: "chat", name: item.value });
    this.bodyContainer.addChild(this.list);
  }

  private renderFooter(): void {
    this.footerContainer.clear();
    const hints = this.isBrowsing()
      ? [
          rawKeyHint("↑/↓", "browse"),
          rawKeyHint("enter", "chat"),
          rawKeyHint("tab", "details"),
          rawKeyHint("type", "to search commands"),
          rawKeyHint("ctrl+c", "quit"),
        ]
      : [rawKeyHint("↑/↓", "select"), rawKeyHint("tab", "complete"), rawKeyHint("enter", "run"), rawKeyHint("esc", "clear")];
    this.footerContainer.addChild(new Text(hints.join(theme.fg("muted", " · ")), 1, 0));
  }

  handleInput(data: string): void {
    if (matchesKey(data, "ctrl+c")) {
      this.ctx.quit();
      return;
    }
    if (this.isBrowsing()) {
      // Moving on from command feedback — drop any stale error.
      this.statusContainer.clear();
      if (matchesKey(data, "tab") || matchesKey(data, "right")) {
        const selected = this.list?.getSelectedItem();
        if (selected) void this.ctx.navigate({ to: "agent", name: selected.value });
        return;
      }
      if (this.list && (matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "enter"))) {
        this.list.handleInput(data);
        return;
      }
      this.editor.handleInput(data);
      return;
    }
    // Command mode: the editor owns the menu, Tab, typing, and Enter (completes + runs in one press).
    this.editor.handleInput(data);
  }

  /** Dispatch the submitted command (/name, or raw text the user never completed). */
  private runCommand(text: string): void {
    const name = text.trim().replace(/^\//, "");
    if (name === "") return;
    if (name === "new") this.openCreate();
    else if (name === "quit") this.ctx.quit();
    else if (name === "model") this.showModelSelector();
    else if (name === "thinking") this.showThinkingSelector();
    else if (name === "login") this.showLoginFlow();
    else if (name === "logout") void this.showLogoutFlow();
    else this.showStatus(theme.fg("warning", `Unknown command: ${name}`));
  }

  private showStatus(line: string): void {
    this.statusContainer.clear();
    this.statusContainer.addChild(new Text(line, 1, 0));
    this.ctx.tui.requestRender();
  }

  private openCreate(): void {
    // Drop the bar cursor while the overlay owns input, else a stray marker lands behind it.
    this.editor.focused = false;
    const create = new CreateAgent({
      create: (name) => this.ctx.steward.create(name),
      onCreated: (agent) => {
        this.overlay?.hide();
        void this.ctx.navigate({ to: "chat", name: agent.name, initialAssistantMessage: BIRTH_OPENER });
      },
      onCancel: () => {
        this.overlay?.hide();
        this.editor.focused = true;
      },
      onQuit: () => this.ctx.quit(),
    });
    this.overlay = this.ctx.tui.showOverlay(create, { anchor: "center", width: "50%", minWidth: 40, maxHeight: "60%" });
  }

  // ---------------------------------------------------------------------------
  // Global auth + model selection. These mirror the in-session `/model`, `/thinking`,
  // `/scoped-models`, `/login`, `/logout` flows from ChatView, but wired to the in-process
  // global tier (this.globalAuth + this.registry) so every write persists to the shared
  // defaults instead of one agent's storage.
  // ---------------------------------------------------------------------------

  /**
   * Swap the bar for a selector in `editorContainer`, focus it (the TUI routes input there), and
   * restore the bar when `done` fires. Mirrors ChatView.showSelector; `focus` may be an inner
   * component (e.g. the thinking selector's list) so the bordered wrapper still renders.
   */
  private showSelector(create: (done: () => void) => { component: Component; focus: Component }): void {
    const { component, focus } = create(() => this.restoreBar());
    this.editorContainer.clear();
    this.editorContainer.addChild(component);
    this.ctx.tui.setFocus(focus);
    this.ctx.tui.requestRender();
  }

  /** Tear down a selector/dialog: restore the (cleared) bar, re-focus the view, reset the footer. */
  private restoreBar(): void {
    this.editorContainer.clear();
    this.editor.setText("");
    this.editorContainer.addChild(this.editor);
    this.editor.focused = true;
    this.renderFooter();
    this.ctx.tui.setFocus(this);
    this.ctx.tui.requestRender();
  }

  /** Single-line text dialog (API key entry, OAuth prompts), swapped into the bar like a selector. */
  private promptInput(title: string, placeholder?: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      const input = new ExtensionInputComponent(
        title,
        placeholder,
        (value) => {
          this.restoreBar();
          resolve(value);
        },
        () => {
          this.restoreBar();
          resolve(undefined);
        },
        { tui: this.ctx.tui },
      );
      this.editorContainer.clear();
      this.editorContainer.addChild(input);
      this.ctx.tui.setFocus(input);
      this.ctx.tui.requestRender();
    });
  }

  /** Pick-one dialog used by OAuth `onSelect`, swapped into the bar like a selector. */
  private promptSelect(title: string, options: string[]): Promise<string | undefined> {
    return new Promise((resolve) => {
      const selector = new ExtensionSelectorComponent(
        title,
        options,
        (option) => {
          this.restoreBar();
          resolve(option);
        },
        () => {
          this.restoreBar();
          resolve(undefined);
        },
        { tui: this.ctx.tui },
      );
      this.editorContainer.clear();
      this.editorContainer.addChild(selector);
      this.ctx.tui.setFocus(selector);
      this.ctx.tui.requestRender();
    });
  }

  /** Resolve the shared default `provider/model` reference to a concrete model from the candidate list. */
  private currentDefaultModel(available: Model<Api>[]): Model<Api> | undefined {
    const modelId = getDefaultModel();
    if (!modelId) return undefined;
    const provider = getDefaultProvider();
    const reference = provider ? `${provider}/${modelId}` : modelId;
    return findExactModelReferenceMatch(reference, available);
  }

  /** `/model` — pick the default model new sessions inherit (persisted to the shared defaults). */
  private showModelSelector(initialSearchInput?: string): void {
    const available = this.registry.getAvailable();
    if (available.length === 0) {
      this.showStatus("No models available — use /login to add a provider.");
      return;
    }
    const current = this.currentDefaultModel(available);
    this.showSelector((done) => {
      const selector = new ModelSelectorComponent(
        this.ctx.tui,
        current,
        available,
        [],
        (model) => {
          setSharedDefaultModel(model.provider, model.id);
          done();
          this.showStatus(`Default model: ${model.provider}/${model.id}`);
        },
        () => done(),
        initialSearchInput,
      );
      return { component: selector, focus: selector };
    });
  }

  /** `/thinking` — pick the default thinking level (persisted to the shared defaults). */
  private showThinkingSelector(): void {
    const current = this.currentDefaultModel(this.registry.getAvailable());
    const levels = (current ? getSupportedThinkingLevels(current) : THINKING_LEVELS) as ThinkingLevel[];
    const currentLevel = (getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL) as ThinkingLevel;
    this.showSelector((done) => {
      const selector = new ThinkingSelectorComponent(
        currentLevel,
        levels,
        (level) => {
          setSharedDefaultThinkingLevel(level);
          done();
          this.showStatus(`Default thinking level: ${level}`);
        },
        () => done(),
      );
      return { component: selector, focus: selector.getSelectList() };
    });
  }

  /** `/login` — pick an auth method, then a provider, then run the global login. */
  private showLoginFlow(): void {
    const subscriptionLabel = "Use a subscription";
    const apiKeyLabel = "Use an API key";
    this.showSelector((done) => {
      const selector = new ExtensionSelectorComponent(
        "Select authentication method:",
        [subscriptionLabel, apiKeyLabel],
        (option) => {
          done();
          void this.showLoginProviderSelector(option === subscriptionLabel ? "oauth" : "api_key");
        },
        () => done(),
      );
      return { component: selector, focus: selector };
    });
  }

  private async showLoginProviderSelector(authType: "oauth" | "api_key"): Promise<void> {
    const providers = this.loginProviderOptions(authType);
    if (providers.length === 0) {
      this.showStatus(authType === "oauth" ? "No subscription providers available." : "No API key providers available.");
      return;
    }
    this.showSelector((done) => {
      const selector = new ExtensionSelectorComponent(
        "Select a provider:",
        providers.map((provider) => provider.name),
        async (label) => {
          done();
          const provider = providers.find((p) => p.name === label);
          if (!provider) return;
          try {
            await this.runLogin(provider.id, provider.authType, provider.name);
            this.showStatus(`Logged in to ${provider.name}.`);
          } catch (error) {
            this.showStatus(theme.fg("warning", error instanceof Error ? error.message : String(error)));
          }
        },
        () => done(),
      );
      return { component: selector, focus: selector };
    });
  }

  /**
   * Login-eligible providers: every OAuth provider plus every API-key model provider. Mirrors
   * AgentRuntime.getLoginProviderOptions, but reads the in-process global registry/auth.
   */
  private loginProviderOptions(authType?: "oauth" | "api_key"): { id: string; name: string; authType: "oauth" | "api_key" }[] {
    const oauthProviders = this.globalAuth.getOAuthProviders();
    const oauthProviderIds = new Set(oauthProviders.map((provider) => provider.id));
    const options: { id: string; name: string; authType: "oauth" | "api_key" }[] = oauthProviders.map((provider) => ({
      id: provider.id,
      name: provider.name,
      authType: "oauth",
    }));
    for (const providerId of new Set(this.registry.getAll().map((model) => model.provider))) {
      if (!isApiKeyLoginProvider(providerId, oauthProviderIds)) continue;
      options.push({ id: providerId, name: this.registry.getProviderDisplayName(providerId), authType: "api_key" });
    }
    const filtered = authType ? options.filter((option) => option.authType === authType) : options;
    return filtered.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Run the login against the global credential tier. OAuth routes its prompts through the local
   * dialogs (browser + paste/select); API-key reads the key inline. Mirrors AgentRuntime.login.
   */
  private async runLogin(provider: string, authType: "oauth" | "api_key", displayName: string): Promise<void> {
    if (authType === "oauth") {
      const callbacks: OAuthLoginCallbacks = {
        onAuth: (info) => {
          openBrowser(info.url);
          this.showStatus(info.instructions ? `${info.url}\n${info.instructions}` : info.url);
        },
        onDeviceCode: (info) => this.showStatus(`Enter code ${info.userCode} at ${info.verificationUri}`),
        onPrompt: async (prompt) => (await this.promptInput(prompt.message, prompt.placeholder)) ?? "",
        onProgress: (message) => this.showStatus(message),
        onSelect: async (prompt: OAuthSelectPrompt) => {
          const selectedLabel = await this.promptSelect(prompt.message, prompt.options.map((option) => option.label));
          return prompt.options.find((option) => option.label === selectedLabel)?.id;
        },
      };
      await this.globalAuth.login(provider as OAuthProviderId, callbacks);
    } else {
      const key = (await this.promptInput(`Enter API key for ${displayName}`))?.trim();
      if (!key) throw new Error("API key cannot be empty.");
      this.globalAuth.set(provider, { type: "api_key", key });
    }
    this.registry.refresh();
  }

  /** `/logout` — pick a globally stored provider and remove its credential. */
  private async showLogoutFlow(): Promise<void> {
    const providers = this.logoutProviderOptions();
    if (providers.length === 0) {
      this.showStatus("No stored credentials to remove.");
      return;
    }
    this.showSelector((done) => {
      const selector = new ExtensionSelectorComponent(
        "Log out of which provider?",
        providers.map((provider) => provider.name),
        (label) => {
          done();
          const provider = providers.find((p) => p.name === label);
          if (!provider) return;
          this.globalAuth.logout(provider.id);
          this.registry.refresh();
          this.showStatus(`Logged out of ${provider.name}.`);
        },
        () => done(),
      );
      return { component: selector, focus: selector };
    });
  }

  private logoutProviderOptions(): { id: string; name: string }[] {
    const options: { id: string; name: string }[] = [];
    for (const providerId of this.globalAuth.list()) {
      if (!this.globalAuth.get(providerId)) continue;
      options.push({ id: providerId, name: this.registry.getProviderDisplayName(providerId) });
    }
    return options.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** List at the top; bar + status + footer pinned to the bottom, a filler between. The menu renders
   * inside editorContainer, growing upward into the filler. */
  render(width: number): string[] {
    const header = this.headerContainer.render(width);
    const body = this.bodyContainer.render(width);
    const bar = this.editorContainer.render(width);
    const status = this.statusContainer.render(width);
    const footer = this.footerContainer.render(width);
    // +1 for a blank line of breathing room under the header.
    const used = header.length + 1 + body.length + bar.length + status.length + footer.length;
    const rows = this.ctx?.tui.terminal.rows ?? used + 1;
    const filler = new Array(Math.max(0, rows - used)).fill("");
    return [...header, "", ...body, ...filler, ...bar, ...status, ...footer];
  }

  focusTarget(): Component {
    return this;
  }

  onUnmount(): void {
    this.overlay?.hide();
  }
}

/**
 * Feeds the bar: fuzzy-filters HOME_SLASH_COMMANDS against the whole line and completes to "/name "
 * so onSubmit dispatches it like a chat slash command. Null on an empty bar keeps the menu closed.
 */
class HomeCommandProvider implements AutocompleteProvider {
  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
  ): Promise<AutocompleteSuggestions | null> {
    const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
    if (before.trim() === "") return null;
    const query = before.trimStart().replace(/^\//, "");
    const matches = fuzzyFilter([...HOME_SLASH_COMMANDS], query, (command) => command.name);
    if (matches.length === 0) return null;
    return {
      items: matches.map((command) => ({
        value: command.name,
        label: command.name,
        description: command.description,
      })),
      prefix: before,
    };
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    const currentLine = lines[cursorLine] ?? "";
    const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
    const afterCursor = currentLine.slice(cursorCol);
    const newLines = [...lines];
    newLines[cursorLine] = `${beforePrefix}/${item.value} ${afterCursor}`;
    return { lines: newLines, cursorLine, cursorCol: beforePrefix.length + item.value.length + 2 };
  }
}

interface CreateAgentCallbacks {
  create: (name: string) => Agent;
  onCreated: (agent: Agent) => void;
  onCancel: () => void;
  onQuit: () => void;
}

// New-agent modal; dashboard-only, so it lives here rather than in its own file.
class CreateAgent implements Component, Focusable {
  private readonly callbacks: CreateAgentCallbacks;
  private readonly input = new Input();
  private readonly status = new Text("", 1, 0);
  private readonly box = new Box(2, 1, (t) => theme.bg("selectedBg", t));

  constructor(callbacks: CreateAgentCallbacks) {
    this.callbacks = callbacks;
    this.box.addChild(new Text(theme.fg("accent", "New agent"), 1, 0));
    this.box.addChild(new Text(theme.fg("dim", "What would you like to name the agent?"), 1, 0));
    this.box.addChild(this.input);
    this.box.addChild(this.status);
    this.box.addChild(new Spacer(1));
    this.box.addChild(new Text(theme.fg("dim", "enter create · esc cancel"), 1, 0));
  }

  get focused(): boolean {
    return this.input.focused;
  }
  set focused(value: boolean) {
    this.input.focused = value;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "ctrl+c")) {
      this.callbacks.onQuit();
      return;
    }
    if (matchesKey(data, "escape")) {
      this.callbacks.onCancel();
      return;
    }
    if (matchesKey(data, "enter")) {
      this.submit();
      return;
    }
    this.input.handleInput(data);
  }

  private submit(): void {
    const name = this.input.getValue().trim();
    if (name.length === 0) return;
    try {
      this.callbacks.onCreated(this.callbacks.create(name));
    } catch (error) {
      this.status.setText(theme.fg("warning", error instanceof Error ? error.message : String(error)));
    }
  }

  render(width: number): string[] {
    return this.box.render(width);
  }

  invalidate(): void {
    this.box.invalidate();
  }
}

