/**
 * The `@opsyhq/steward` client surface:
 *   - `Steward`       — the agent collection (`list`/`get`/`create`).
 *   - `Agent`         — one agent: registry data + lifecycle + the `fetch`/SSE transport to its daemon
 *                       (the root control stream, the `send` site, the session map).
 *   - `SessionHandle` — the per-session proxy the TUI and `--print` drive, over `/sessions/:id/*`.
 */

import { spawn } from "node:child_process";
import {
	type Api,
	type AssistantMessage,
	getSupportedThinkingLevels,
	type ImageContent,
	type Model,
} from "@earendil-works/pi-ai";
import type { AgentHarnessEvent, AgentMessage, SessionContext, SessionTreeEntry, ThinkingLevel } from "@opsyhq/agent";
import type { ContextInfo, IntegrationInfo } from "./core/agent-runtime.ts";
import { type AgentConfig, AgentSettingsManager } from "./core/agent-settings-manager.ts";
import { type DaemonConfig, deleteDaemonConfig, loadDaemonConfig } from "./core/daemon-config.ts";
import { THINKING_LEVELS } from "./core/defaults.ts";
import type { ResourceSummary } from "./core/diagnostics.ts";
import type {
	ExtensionContext,
	ExtensionShortcut,
	MessageRenderer,
	SlashCommandInfo,
	ToolInfo,
	UserBashEvent,
	UserBashEventResult,
} from "./core/extensions/index.ts";
import type { KeyId } from "./core/keybindings.ts";
import type { ScopedModel } from "./core/model-resolver.ts";
import type { ConfiguredPlugin } from "./core/plugin-manager.ts";
import { daemonLaunchCommand, getServiceManager } from "./core/service/service-manager.ts";
import type { Skill } from "./core/skills.ts";
import type {
	AuthSelectorProvider,
	DaemonAgentState,
	DaemonCommand,
	DaemonControlEvent,
	DaemonResponse,
	DaemonSessionState,
	DaemonSessionSummary,
	ExtensionUIRequest,
	OnboardServiceResult,
	ScopedModelsUpdateEvent,
} from "./types.ts";

const HEALTH_TIMEOUT_MS = 15_000;
const HEALTH_POLL_MS = 150;

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type SessionEvent = AgentHarnessEvent | ScopedModelsUpdateEvent;

/**
 * Consume an SSE response body: split on frame boundaries, parse each `event:`/`data:` frame (joining
 * multi-line `data:`), and hand it to `onFrame`. A single malformed frame is skipped, not fatal.
 */
async function consumeSSE(
	body: ReadableStream<Uint8Array>,
	onFrame: (event: string, data: string) => void,
): Promise<void> {
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		for await (const chunk of body) {
			buffer += decoder.decode(chunk, { stream: true });
			let boundary = buffer.indexOf("\n\n");
			while (boundary >= 0) {
				const raw = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				boundary = buffer.indexOf("\n\n");
				let event = "message";
				let data = "";
				for (const line of raw.split("\n")) {
					if (line.startsWith(":")) continue; // keepalive comment
					if (line.startsWith("event:")) event = line.slice(6).trim();
					else if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(5).replace(/^ /, "");
				}
				if (!data) continue;
				try {
					onFrame(event, data);
				} catch {
					// A single bad frame must not kill the stream.
				}
			}
		}
	} catch {
		// The stream ended or was aborted.
	}
}

/** Top level: the agent collection on disk. Holds no required state. */
export class Steward {
	/** Every agent under the agents root, as handles. */
	list(): Agent[] {
		return AgentSettingsManager.list().map((store) => new Agent(store.config));
	}

	/** A handle for `name` if it exists on disk, else `undefined`. */
	get(name: string): Agent | undefined {
		const store = AgentSettingsManager.get(name);
		return store ? new Agent(store.config) : undefined;
	}

	/** Create the agent's home tree and return its handle. */
	create(name: string, opts: { purpose?: string; model?: string } = {}): Agent {
		return new Agent(AgentSettingsManager.createAgent({ name, ...opts }).config);
	}
}

/**
 * One agent: registry data, per-agent lifecycle, and the `fetch`/SSE transport to its per-agent daemon
 * — the single `fetch` site (`send`), the root control stream (agent snapshot + session lifecycle), and
 * the `SessionHandle` map. Per-session work rides a `SessionHandle` built by `session(id)`.
 */
export class Agent {
	readonly config: AgentConfig;
	/** The resident `SessionHandle`s, keyed by session id. */
	readonly sessions = new Map<string, SessionHandle>();

	// Not readonly: `reconnect()` re-points the transport at a different daemon (the deploy handoff).
	private base?: string;
	private token?: string;
	private agentState?: DaemonAgentState;
	private controlAbort?: AbortController;
	private readonly controlSubscribers = new Set<(e: DaemonControlEvent) => void>();

	constructor(config: AgentConfig) {
		this.config = config;
	}

	get name(): string {
		return this.config.name;
	}

	/**
	 * Find the agent's live daemon (config → /health) and attach, else spawn a detached `daemon <name>`
	 * (the same command the OS service unit runs) and wait for it. Ensures the control link; opens no
	 * session (use `session(id)` / `listSessions()`).
	 */
	async connect(): Promise<void> {
		const existing = loadDaemonConfig(this.name);
		if (existing && (await isHealthy(existing.port))) {
			await this.attach(`http://127.0.0.1:${existing.port}`, existing.token);
			return;
		}

		// The launch command goes through the running binary, since `steward` isn't on PATH in dev.
		const [command, ...commandArgs] = daemonLaunchCommand(this.name);
		const child = spawn(command, commandArgs, { detached: true, stdio: "ignore" });
		child.unref();

		const config = await waitForHealth(this.name);
		await this.attach(`http://127.0.0.1:${config.port}`, config.token);
	}

	/** Attach to a known daemon endpoint and open the control stream. */
	async attach(base: string, token: string): Promise<void> {
		this.base = base;
		this.token = token;
		await this.openControlStream();
	}

	/** The agent-global snapshot (config, cwd, session list) from the control stream's hello. */
	getAgentState(): DaemonAgentState {
		if (!this.agentState) throw new Error("Agent not connected. Call connect()/attach() first.");
		return this.agentState;
	}

	/** Subscribe to session lifecycle frames (added/removed/renamed) off the control stream. */
	subscribeControl(cb: (e: DaemonControlEvent) => void): () => void {
		this.controlSubscribers.add(cb);
		return () => this.controlSubscribers.delete(cb);
	}

	/** The stored sessions (resident + idle), newest first — round-trips `GET /sessions`. */
	async listSessions(): Promise<DaemonSessionSummary[]> {
		const response = await fetch(`${this.base}/sessions`, {
			headers: { authorization: `Bearer ${this.token}` },
		});
		const body = (await response.json()) as DaemonAgentState;
		this.agentState = body;
		return body.sessions;
	}

	/** Build (or return the cached) `SessionHandle` for a session id, opening its event stream. */
	async session(id: string): Promise<SessionHandle> {
		const existing = this.sessions.get(id);
		if (existing) return existing;
		const handle = await SessionHandle.create(this, id);
		this.sessions.set(id, handle);
		return handle;
	}

	/** Open the agent's most-recent session — the daemon guarantees at least one exists. */
	async openLatestSession(): Promise<SessionHandle> {
		const [latest] = await this.listSessions();
		if (!latest) throw new Error(`No session for agent "${this.name}".`);
		return this.session(latest.sessionId);
	}

	/** POST a command to a session's `/control` and unwrap the response. */
	async send<T>(sessionId: string, cmd: DaemonCommand): Promise<T> {
		const response = await fetch(`${this.base}/sessions/${sessionId}/control`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
			body: JSON.stringify(cmd),
		});
		const body = (await response.json()) as DaemonResponse;
		if (!body.success) throw new Error(body.error);
		return body.data as T;
	}

	/** Answer a parked daemon-side dialog for a session (fire-and-forget). */
	async respondUi(sessionId: string, id: string, answer: Record<string, unknown>): Promise<void> {
		await fetch(`${this.base}/sessions/${sessionId}/ui-response`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
			body: JSON.stringify({ type: "extension_ui_response", id, ...answer }),
		});
	}

	/** The base URL + bearer token, for a `SessionHandle` to open its own event stream. */
	endpoint(): { base: string; token: string } {
		if (!this.base || !this.token) throw new Error("Agent not connected. Call connect()/attach() first.");
		return { base: this.base, token: this.token };
	}

	/** Open the root control stream and resolve once the agent snapshot lands; consume frames in the background. */
	private async openControlStream(): Promise<void> {
		this.controlAbort = new AbortController();
		const response = await fetch(`${this.base}/events`, {
			headers: { authorization: `Bearer ${this.token}` },
			signal: this.controlAbort.signal,
		});
		if (!response.ok || !response.body) {
			throw new Error(`Failed to open daemon control stream (HTTP ${response.status}).`);
		}
		const hello = deferred<void>();
		void consumeSSE(response.body, (event, data) => {
			if (event === "hello") {
				this.agentState = JSON.parse(data) as DaemonAgentState;
				hello.resolve();
				return;
			}
			const evt = JSON.parse(data) as DaemonControlEvent;
			for (const subscriber of this.controlSubscribers) subscriber(evt);
		});
		await hello.promise;
	}

	/**
	 * Re-point the transport at a different daemon (deploy handoff). The existing session streams are
	 * dropped (the caller reopens sessions on the new daemon); the control subscriber set survives.
	 */
	async reconnect(port: number, token: string): Promise<void> {
		this.controlAbort?.abort();
		for (const handle of this.sessions.values()) handle.close();
		this.sessions.clear();
		this.base = `http://127.0.0.1:${port}`;
		this.token = token;
		await this.openControlStream();
	}

	/** Close every session stream and the control stream. */
	close(): void {
		for (const handle of this.sessions.values()) handle.close();
		this.sessions.clear();
		this.controlAbort?.abort();
	}

	/**
	 * Tear the agent down: uninstall the OS service (so a supervised daemon won't relaunch), SIGTERM any
	 * daemon still running (a birth daemon has no unit but is a live process), delete the home dir, then
	 * drop the daemon config. `AgentSettingsManager.delete` touches only the agent home.
	 */
	delete(): { ok: boolean; method: "trash" | "unlink"; error?: string } {
		getServiceManager().uninstall(this.name);

		const daemon = loadDaemonConfig(this.name);
		if (daemon) {
			try {
				process.kill(daemon.pid, "SIGTERM");
			} catch {
				// Already gone.
			}
		}

		const result = AgentSettingsManager.delete(this.name);
		if (result.ok) deleteDaemonConfig(this.name);
		return result;
	}

	/**
	 * Restart the agent's daemon so it picks up code changes (the in-process reload rebuilds only
	 * resources, not the running binary). A supervised daemon (launchd/systemd unit) is bounced via the
	 * service manager so its supervisor relaunches it; an unsupervised dev/birth daemon spawned by
	 * `connect()` is SIGTERMed and respawned here. Resolves once the replacement daemon (a new pid) is
	 * healthy; sessions resume from disk, so in-memory turn state is lost.
	 */
	async restart(): Promise<void> {
		const existing = loadDaemonConfig(this.name);
		const service = getServiceManager();

		if (service.kind !== "none" && service.isRunning(this.name)) {
			service.stop(this.name);
			service.start(this.name);
		} else {
			if (existing) {
				try {
					process.kill(existing.pid, "SIGTERM");
				} catch {
					// Already gone.
				}
			}
			const [command, ...commandArgs] = daemonLaunchCommand(this.name);
			const child = spawn(command, commandArgs, { detached: true, stdio: "ignore" });
			child.unref();
		}

		await waitForHealth(this.name, (cfg) => cfg.pid !== existing?.pid);
	}
}

/**
 * The per-session proxy the TUI/`--print` drive: verbs round-trip through `agent.send(sessionId, …)`,
 * and the session's event stream (`GET /sessions/:id/events`) arrives into the local snapshot/queue
 * caches. Reads that change rarely (resource summary, commands) are served from the cache; per-turn
 * reads (entries, messages) round-trip. Agent-global reads (config/cwd) come off the owning `Agent`.
 */
export class SessionHandle {
	private readonly agent: Agent;
	readonly sessionId: string;
	private snap: DaemonSessionState;
	private queue: { steer: AgentMessage[]; followUp: AgentMessage[] } = { steer: [], followUp: [] };
	private resourceSummary: ResourceSummary = { extensions: 0, skills: 0, prompts: 0, commands: 0, diagnostics: [] };
	private commands: SlashCommandInfo[] = [];

	private readonly handlers = new Set<(e: AgentHarnessEvent) => void>();
	private streamAbort?: AbortController;
	onUiRequest?: (req: ExtensionUIRequest) => void;

	private constructor(agent: Agent, sessionId: string, snap: DaemonSessionState) {
		this.agent = agent;
		this.sessionId = sessionId;
		this.snap = snap;
	}

	static async create(agent: Agent, sessionId: string): Promise<SessionHandle> {
		const { base, token } = agent.endpoint();
		const abort = new AbortController();
		const response = await fetch(`${base}/sessions/${sessionId}/events`, {
			headers: { authorization: `Bearer ${token}` },
			signal: abort.signal,
		});
		if (!response.ok || !response.body) {
			throw new Error(`Failed to open session event stream for "${sessionId}" (HTTP ${response.status}).`);
		}
		const hello = deferred<DaemonSessionState>();
		const handle = new SessionHandle(agent, sessionId, {
			sessionId,
			thinkingLevel: "off",
			scopedModels: [],
			isStreaming: false,
			messageCount: 0,
			pendingMessageCount: 0,
		});
		handle.streamAbort = abort;
		void consumeSSE(response.body, (event, data) => handle.handleFrame(event, data, hello));
		handle.snap = await hello.promise;
		await handle.refreshResources();
		return handle;
	}

	/** Route one parsed SSE frame: hello → snapshot; extension-UI request → bridge; else event. */
	private handleFrame(event: string, data: string, hello: Deferred<DaemonSessionState>): void {
		if (event === "hello") {
			hello.resolve(JSON.parse(data) as DaemonSessionState);
			return;
		}
		const evt = JSON.parse(data) as SessionEvent | ExtensionUIRequest;
		if (evt.type === "extension_ui_request") {
			this.onUiRequest?.(evt);
			return;
		}
		this.routeEvent(evt);
	}

	/** Update the caches off the stream, then fan harness events out to subscribers. */
	private routeEvent(evt: SessionEvent): void {
		switch (evt.type) {
			case "model_update":
				this.snap.model = evt.model;
				break;
			case "thinking_level_update":
				this.snap.thinkingLevel = evt.level;
				break;
			case "scoped_models_update":
				// Cache-only; not forwarded to subscribers.
				this.snap.scopedModels = evt.scopedModels;
				return;
			case "queue_update":
				this.queue = { steer: evt.steer, followUp: evt.followUp };
				break;
		}
		for (const handler of this.handlers) handler(evt);
	}

	private async refreshResources(): Promise<void> {
		const [resourceSummary, commands] = await Promise.all([
			this.agent.send<ResourceSummary>(this.sessionId, { type: "get_resource_summary" }),
			this.agent.send<{ commands: SlashCommandInfo[] }>(this.sessionId, { type: "get_commands" }),
		]);
		this.resourceSummary = resourceSummary;
		this.commands = commands.commands;
	}

	close(): void {
		this.streamAbort?.abort();
		this.agent.sessions.delete(this.sessionId);
	}

	subscribe(cb: (e: AgentHarnessEvent) => void): () => void {
		this.handlers.add(cb);
		return () => this.handlers.delete(cb);
	}

	prompt(
		message: string,
		opts?: { images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" },
	): Promise<void> {
		return this.agent.send(this.sessionId, {
			type: "prompt",
			message,
			images: opts?.images,
			streamingBehavior: opts?.streamingBehavior,
		});
	}

	compact(customInstructions?: string): Promise<unknown> {
		return this.agent.send(this.sessionId, { type: "compact", customInstructions });
	}

	abort(): Promise<unknown> {
		return this.agent.send(this.sessionId, { type: "abort" });
	}

	waitForIdle(): Promise<void> {
		return this.agent.send(this.sessionId, { type: "wait_for_idle" });
	}

	async reload(): Promise<void> {
		await this.agent.send(this.sessionId, { type: "reload" });
		// A reload can change config-derived state, so refresh the snapshot too.
		this.snap = await this.agent.send<DaemonSessionState>(this.sessionId, { type: "get_state" });
		await this.refreshResources();
	}

	/** Create a fresh session (additive) and return its snapshot — the caller opens + switches to it. */
	createSession(): Promise<DaemonSessionState> {
		return this.agent.send<DaemonSessionState>(this.sessionId, { type: "create_session" });
	}

	/**
	 * Persist the deploy. The daemon flips the latch, registers the OS service, and creates a fresh
	 * deployed session (returned); with a real backend it also starts a supervised daemon on a new port,
	 * so we reconnect the agent's transport onto it (told apart from the birth daemon by pid) and stop the
	 * birth daemon. The caller opens + switches to the returned session. The `none` backend stays put.
	 */
	async deploy(): Promise<DaemonSessionState> {
		// Capture the birth daemon before its config is overwritten by the supervised one.
		const birth = loadDaemonConfig(this.agent.name);
		const snap = await this.agent.send<DaemonSessionState>(this.sessionId, { type: "deploy" });

		if (getServiceManager().kind === "none") return snap;

		// Wait for the supervised daemon (a different pid), then move the agent's transport onto it.
		const supervised = await waitForHealth(this.agent.name, (cfg) => cfg.pid !== birth?.pid);
		await this.agent.reconnect(supervised.port, supervised.token);

		// Stop the birth daemon; its shutdown won't touch the now-supervised config.
		if (birth) {
			try {
				process.kill(birth.pid, "SIGTERM");
			} catch {
				// Already gone.
			}
		}
		return snap;
	}

	clearQueue(): Promise<{ steering: AgentMessage[]; followUp: AgentMessage[] }> {
		return this.agent.send(this.sessionId, { type: "clear_queue" });
	}

	seedAssistantMessage(text: string): Promise<AssistantMessage> {
		return this.agent.send(this.sessionId, { type: "seed_assistant_message", text });
	}

	appendMessage(message: AgentMessage): Promise<void> {
		return this.agent.send(this.sessionId, { type: "append_message", message });
	}

	// ---- Plugin verbs: single-writer mutations the daemon applies, then self-reloads ----
	installPlugin(source: string): Promise<void> {
		return this.agent.send(this.sessionId, { type: "install_plugin", source });
	}

	removePlugin(source: string): Promise<{ removed: boolean }> {
		return this.agent.send(this.sessionId, { type: "remove_plugin", source });
	}

	updatePlugins(source?: string): Promise<void> {
		return this.agent.send(this.sessionId, { type: "update_plugins", source });
	}

	async onboardPlugin(source: string): Promise<OnboardServiceResult[]> {
		const { results } = await this.agent.send<{ results: OnboardServiceResult[] }>(this.sessionId, {
			type: "onboard_plugin",
			source,
		});
		return results;
	}

	/** Per-turn read — round-trips. */
	async getEntries(): Promise<SessionTreeEntry[]> {
		const { entries } = await this.agent.send<{ entries: SessionTreeEntry[] }>(this.sessionId, {
			type: "get_entries",
		});
		return entries;
	}

	async listTools(): Promise<{ tools: ToolInfo[]; activeToolNames: string[] }> {
		return this.agent.send<{ tools: ToolInfo[]; activeToolNames: string[] }>(this.sessionId, {
			type: "get_tool_info",
		});
	}

	async listIntegrations(): Promise<IntegrationInfo[]> {
		return (
			await this.agent.send<{ integrations: IntegrationInfo[] }>(this.sessionId, { type: "get_integration_info" })
		).integrations;
	}

	async listSkills(): Promise<Skill[]> {
		return (await this.agent.send<{ skills: Skill[] }>(this.sessionId, { type: "get_skills" })).skills;
	}

	async listPlugins(): Promise<ConfiguredPlugin[]> {
		return (await this.agent.send<{ plugins: ConfiguredPlugin[] }>(this.sessionId, { type: "get_plugins" })).plugins;
	}

	async listContexts(): Promise<ContextInfo[]> {
		return (await this.agent.send<{ contexts: ContextInfo[] }>(this.sessionId, { type: "get_context_info" }))
			.contexts;
	}

	async getAvailableModels(): Promise<Model<Api>[]> {
		return (await this.agent.send<{ models: Model<Api>[] }>(this.sessionId, { type: "get_available_models" })).models;
	}

	/** Switch the live model; the daemon persists the default and emits model_update. */
	setModel(provider: string, modelId: string): Promise<Model<Api>> {
		return this.agent.send(this.sessionId, { type: "set_model", provider, modelId });
	}

	async getLoginProviderOptions(authType?: "oauth" | "api_key"): Promise<AuthSelectorProvider[]> {
		return (
			await this.agent.send<{ providers: AuthSelectorProvider[] }>(this.sessionId, {
				type: "get_login_providers",
				authType,
			})
		).providers;
	}

	async getLogoutProviderOptions(): Promise<AuthSelectorProvider[]> {
		return (
			await this.agent.send<{ providers: AuthSelectorProvider[] }>(this.sessionId, { type: "get_logout_providers" })
		).providers;
	}

	/** Run a provider login daemon-side (credentials never cross the wire); OAuth prompts round-trip via respondUi. */
	login(provider: string, authType: "oauth" | "api_key"): Promise<void> {
		return this.agent.send(this.sessionId, { type: "login", provider, authType });
	}

	logout(provider: string): Promise<void> {
		return this.agent.send(this.sessionId, { type: "logout", provider });
	}

	getModel(): Model<Api> | undefined {
		return this.snap.model;
	}

	getScopedModels(): ScopedModel[] {
		return this.snap.scopedModels;
	}

	/** Switch the session-only scope; the daemon resolves the patterns and emits scoped_models_update. */
	setScopedModels(enabledModelIds: string[]): Promise<void> {
		return this.agent.send(this.sessionId, { type: "set_scoped_models", enabledModelIds });
	}

	/** Persist the agent-tier scoped-model shortlist to agent.json. */
	setEnabledModels(enabledModels: string[] | undefined): Promise<void> {
		return this.agent.send(this.sessionId, { type: "set_enabled_models", enabledModels });
	}

	getThinkingLevel(): ThinkingLevel {
		return this.snap.thinkingLevel;
	}

	/** The thinking levels the current model supports, or the full set when no model is resolved. */
	getAvailableThinkingLevels(): ThinkingLevel[] {
		const model = this.snap.model;
		if (!model) return THINKING_LEVELS;
		return getSupportedThinkingLevels(model) as ThinkingLevel[];
	}

	setThinkingLevel(level: ThinkingLevel): Promise<void> {
		return this.agent.send(this.sessionId, { type: "set_thinking_level", level });
	}

	/** Per-turn read — round-trips (only `.messages` is consumed client-side). */
	async buildSessionContext(): Promise<SessionContext> {
		const { messages } = await this.agent.send<{ messages: AgentMessage[] }>(this.sessionId, {
			type: "get_messages",
		});
		return { messages, thinkingLevel: this.snap.thinkingLevel, model: null, activeToolNames: null };
	}

	// ---- Snapshot reads — no round-trip ----
	get config(): AgentConfig {
		return this.agent.getAgentState().config;
	}

	getCwd(): string {
		return this.agent.getAgentState().cwd;
	}

	getSessionName(): string | undefined {
		return this.snap.sessionName;
	}

	getResourceSummary(): ResourceSummary {
		return this.resourceSummary;
	}

	getCommands(): SlashCommandInfo[] {
		return this.commands;
	}

	getSteeringMessages(): AgentMessage[] {
		return this.queue.steer;
	}

	getFollowUpMessages(): AgentMessage[] {
		return this.queue.followUp;
	}

	// ---- Extension surface, inert client-side (the runner lives server-side) ----
	getShortcuts(): Map<KeyId, ExtensionShortcut> {
		return new Map();
	}

	getMessageRenderer(): MessageRenderer | undefined {
		return undefined;
	}

	emitUserBash(_event: UserBashEvent): Promise<UserBashEventResult | undefined> {
		return Promise.resolve(undefined);
	}

	/** Unreachable (`getShortcuts()` is always empty); fails loud rather than fabricating a context. */
	createShortcutContext(): ExtensionContext {
		throw new Error("Extension shortcuts are not wired over the daemon.");
	}

	respondUi(id: string, answer: Record<string, unknown>): Promise<void> {
		return this.agent.respondUi(this.sessionId, id, answer);
	}
}

/** `GET /health` (no auth) answers `{status:"ok"}` while the daemon is listening. */
export async function isHealthy(port: number): Promise<boolean> {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/health`, {
			signal: AbortSignal.timeout(1000),
		});
		if (!response.ok) return false;
		const body = (await response.json()) as { status?: string };
		return body.status === "ok";
	} catch {
		return false;
	}
}

/**
 * Poll the config + `/health` until a matching daemon answers (or time out). The optional predicate
 * narrows which config counts — the deploy handoff waits for the supervised daemon (a pid different
 * from the outgoing birth daemon's).
 */
export async function waitForHealth(
	name: string,
	predicate: (config: DaemonConfig) => boolean = () => true,
): Promise<{ pid: number; port: number; token: string }> {
	const deadline = Date.now() + HEALTH_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const config = loadDaemonConfig(name);
		if (config && predicate(config) && (await isHealthy(config.port))) {
			return { pid: config.pid, port: config.port, token: config.token };
		}
		await sleep(HEALTH_POLL_MS);
	}
	throw new Error(`Daemon for "${name}" did not become healthy within ${HEALTH_TIMEOUT_MS / 1000}s.`);
}
