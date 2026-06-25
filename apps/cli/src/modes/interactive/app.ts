/**
 * The interactive TUI shell. `App` owns the terminal and swaps between pages (dashboard, agent
 * detail, chat). It also owns the open-session list for an agent: one `ChatView` per resident session,
 * shown one at a time via `switchSession(id)` (the others stay mounted + subscribed, just hidden).
 * Navigation is flat: `home()` (←/Esc) returns to the dashboard, `navigate()` opens a page, `quit()`
 * (Ctrl+C) exits. Global init and the sole `tui.start()`/`stop()` live here.
 */

import { type Agent, type DaemonSessionSummary, initTheme, type SessionHandle, type Steward } from "@opsyhq/steward";
import { type Component, Container, ProcessTerminal, setKeybindings, TUI } from "@opsyhq/tui";
import { KeybindingsManager } from "../../keybindings-manager.ts";
import { AgentView } from "./views/agent-view.ts";
import { ChatView } from "./views/chat-view.ts";
import { DashboardView } from "./views/dashboard-view.ts";

/** A newly born agent opens the chat itself, asking its human what it is for. Seeded as the chat opener. */
export const BIRTH_OPENER = "What is my purpose?";

/** A navigation target. The chat route carries the optional birth opener from `new` and a session to open. */
export type Route =
	| { to: "dashboard" }
	| { to: "agent"; name: string }
	| { to: "chat"; name: string; sessionId?: string; initialAssistantMessage?: string };

export type Navigate = (route: Route) => Promise<void>;

/** Wiring handed to each view on mount: the shared TUI, the agent collection, and navigation. */
export interface ViewContext {
	tui: TUI;
	steward: Steward;
	/** Open a page (dashboard → details, dashboard → chat, details → chat). */
	navigate: Navigate;
	/** Return to the global dashboard from anywhere — what ←/Esc map to. */
	home: () => void;
	/** Quit the whole process from anywhere — what Ctrl+C / `/quit` map to. */
	quit: () => void;
	/** The current agent's stored sessions (resident + idle), newest first — backs the session switcher. */
	listSessions: () => Promise<DaemonSessionSummary[]>;
	/**
	 * Show the chat for another session of the current agent, mounting it on first switch. `reset` drops
	 * every open `ChatView` first (used after a deploy reconnect re-points the transport).
	 */
	switchSession: (sessionId: string, options?: { reset?: boolean }) => Promise<void>;
}

/** A page in the shell. Every view is a `Container` so it gets `render`/`addChild`/`clear` for free. */
export interface AppView extends Component {
	onMount(ctx: ViewContext): void | Promise<void>;
	onUnmount(): void;
	focusTarget(): Component;
}

export class App {
	private readonly tui: TUI;
	private readonly steward: Steward;
	private readonly keybindings: KeybindingsManager;
	private readonly root: Container;
	private readonly ctx: ViewContext;
	private current?: AppView;
	// Chat state: the connected agent plus one ChatView per resident session, shown one at a time.
	private chatAgent?: Agent;
	private readonly chatViews = new Map<string, ChatView>();
	private resolveExit?: () => void;
	private stopped = false;

	constructor(steward: Steward) {
		// Theme + keybindings must be initialized before any styling runs.
		initTheme();
		this.keybindings = KeybindingsManager.create();
		setKeybindings(this.keybindings);
		this.tui = new TUI(new ProcessTerminal());
		this.steward = steward;
		this.root = new Container();
		this.tui.addChild(this.root);
		this.ctx = {
			tui: this.tui,
			steward,
			navigate: (route) => this.openView(route),
			home: () => void this.openView({ to: "dashboard" }),
			quit: () => this.stop(),
			listSessions: () => this.chatAgent?.listSessions() ?? Promise.resolve([]),
			switchSession: (sessionId, options) => this.switchSession(sessionId, options),
		};
	}

	/** The single process entry: start the terminal, show the opening route, block until exit. */
	async start(route: Route): Promise<void> {
		this.tui.start();
		await this.openView(route);
		await new Promise<void>((resolve) => {
			this.resolveExit = resolve;
		});
	}

	/** Build a fresh page for the route and swap it in. Unknown agents fall back to the dashboard. */
	private async openView(route: Route): Promise<void> {
		switch (route.to) {
			case "dashboard":
				this.closeChat();
				await this.show(new DashboardView());
				return;
			case "agent": {
				this.closeChat();
				// Crash on the impossible "agent dir vanished" case rather than silently redirecting.
				const agent = this.steward.get(route.name)!;
				let session: SessionHandle | undefined;
				try {
					await agent.connect();
					session = await agent.openLatestSession();
				} catch {
					// Daemon unreachable — still show the page, just without the capability sections.
					session = undefined;
				}
				await this.show(new AgentView(agent, session));
				return;
			}
			case "chat": {
				const agent = this.steward.get(route.name);
				if (!agent) {
					await this.show(new DashboardView());
					return;
				}
				await agent.connect();
				this.chatAgent = agent;
				const handle = route.sessionId ? await agent.session(route.sessionId) : await agent.openLatestSession();
				await this.mountChat(handle, { initialAssistantMessage: route.initialAssistantMessage });
				return;
			}
		}
	}

	/** Swap the visible non-chat view: unmount the old, mount the new onto the root, focus it, repaint. */
	private async show(view: AppView): Promise<void> {
		this.current?.onUnmount();
		this.root.clear();
		this.root.addChild(view);
		this.current = view;
		await view.onMount(this.ctx);
		this.tui.setFocus(view.focusTarget());
		// Force a full repaint: pages differ in height, so prior lines must be cleared.
		this.tui.requestRender(true);
	}

	/** Mount a fresh ChatView for `handle` and make it the visible page. */
	private async mountChat(handle: SessionHandle, options: { initialAssistantMessage?: string }): Promise<void> {
		this.current?.onUnmount();
		const view = new ChatView(handle, options, this.keybindings);
		this.chatViews.set(handle.sessionId, view);
		this.current = view;
		this.root.clear();
		this.root.addChild(view);
		await view.onMount(this.ctx);
		this.tui.setFocus(view.focusTarget());
		this.tui.requestRender(true);
	}

	/**
	 * Show another session's chat, mounting its `ChatView` on first switch. The previously visible chat
	 * view stays mounted + subscribed (just removed from the root), so switching back is instant and its
	 * session stays resident on the daemon. `reset` tears every open view down first.
	 */
	private async switchSession(sessionId: string, options?: { reset?: boolean }): Promise<void> {
		if (!this.chatAgent) return;
		if (options?.reset) {
			for (const view of this.chatViews.values()) view.onUnmount();
			this.chatViews.clear();
		}

		const existing = this.chatViews.get(sessionId);
		if (existing) {
			if (this.current === existing) return;
			this.root.clear();
			this.root.addChild(existing);
			this.current = existing;
			this.tui.setFocus(existing.focusTarget());
			this.tui.requestRender(true);
			return;
		}

		const handle = await this.chatAgent.session(sessionId);
		const view = new ChatView(handle, {}, this.keybindings);
		this.chatViews.set(sessionId, view);
		this.current = view;
		this.root.clear();
		this.root.addChild(view);
		await view.onMount(this.ctx);
		this.tui.setFocus(view.focusTarget());
		this.tui.requestRender(true);
	}

	/** Tear down every open ChatView + the agent transport when leaving chat for another page. */
	private closeChat(): void {
		if (this.chatViews.size === 0 && !this.chatAgent) return;
		for (const view of this.chatViews.values()) view.onUnmount();
		this.chatViews.clear();
		this.chatAgent?.close();
		this.chatAgent = undefined;
		this.current = undefined;
	}

	/** Idempotent shutdown. */
	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		this.closeChat();
		this.current?.onUnmount();
		this.tui.stop();
		this.resolveExit?.();
	}
}
