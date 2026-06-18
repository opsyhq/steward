/**
 * DaemonUIContext — the `ExtensionUIContext` bound onto the daemon's runner, so an extension
 * running inside the daemon can drive dialogs/widgets on a remote interactive client.
 *
 * A near-verbatim port of coding-agent's rpc-mode extension-UI bridge (`rpc-mode.ts`): the
 * parked-promise machinery plus `createExtensionUIContext`, with the transport swapped from a
 * stdout line to an injected `pushFrame` (the SSE broadcaster). The serializable-vs-stub split
 * ports unchanged — it is dictated by JSON-serializability (a function/Component can't cross the
 * wire), not by host capability, so even though steward's client has a full TUI the same surface
 * stays stubbed (custom renderers, component-factory widgets, footer/header/editor-component
 * factories, autocomplete, terminal-input).
 *
 * Steward-forced changes vs the pi copy:
 *   - `output()` → the injected `pushFrame` (an SSE frame, not a stdout line);
 *   - the `set_editor_text` wire value is normalized to camelCase `setEditorText`;
 *   - `editor()` — which pi parks with no abort/timeout path — is made cancellable via
 *     `cancelAllPending()`, so a client that drops mid-dialog doesn't leave it hung forever.
 */

import { randomUUID } from "node:crypto";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../../core/extensions/types.ts";
import { type Theme, theme } from "../interactive/theme/theme.ts";
import type { ExtensionUIRequest, ExtensionUIResponse } from "./daemon-types.ts";

/** The runner-facing UI context plus the daemon-facing inbound/cleanup hooks. */
export interface DaemonUIContext {
	/** The `ExtensionUIContext` to bind onto the runner (`host.bindInteractiveContext`). */
	ui: ExtensionUIContext;
	/** Resolve a parked dialog promise from a `POST /ui-response` body (the inbound half). */
	resolveUiResponse(response: ExtensionUIResponse): void;
	/** Resolve every parked dialog to its cancel value — called when the last SSE client drops. */
	cancelAllPending(): void;
}

/**
 * Each request arm minus `type`/`id` (which `emit` adds). A distributive `Omit` so the union of
 * arms is preserved — a plain `Omit<ExtensionUIRequest, …>` collapses to just the shared `method`.
 */
type UIRequestBody = ExtensionUIRequest extends infer T ? (T extends T ? Omit<T, "type" | "id"> : never) : never;

/**
 * Build the daemon's extension-UI context. `pushFrame` emits one UI request to the SSE clients
 * (the daemon supplies a sink that omits the SSE `id` and skips the replay ring). The
 * parked-promise map is captured in this closure so it survives harness rebinds — the same
 * context object is re-applied by `_applyInteractiveContext` on every rebuild.
 */
export function createDaemonUIContext(pushFrame: (frame: ExtensionUIRequest) => void): DaemonUIContext {
	// Pending dialog requests awaiting a `/ui-response`. Closure-scoped (above any rebind) so
	// in-flight dialogs survive a harness swap.
	const pendingExtensionRequests = new Map<
		string,
		{ resolve: (response: ExtensionUIResponse) => void; reject: (error: Error) => void }
	>();

	const emit = (id: string, body: UIRequestBody): void => {
		pushFrame({ type: "extension_ui_request", id, ...body } as ExtensionUIRequest);
	};

	/** Helper for the awaited dialogs (select/confirm/input) with signal/timeout support. */
	function createDialogPromise<T>(
		opts: ExtensionUIDialogOptions | undefined,
		defaultValue: T,
		body: UIRequestBody,
		parseResponse: (response: ExtensionUIResponse) => T,
	): Promise<T> {
		if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

		const id = randomUUID();
		return new Promise((resolve, reject) => {
			let timeoutId: ReturnType<typeof setTimeout> | undefined;

			const cleanup = () => {
				if (timeoutId) clearTimeout(timeoutId);
				opts?.signal?.removeEventListener("abort", onAbort);
				pendingExtensionRequests.delete(id);
			};

			const onAbort = () => {
				cleanup();
				resolve(defaultValue);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			if (opts?.timeout) {
				timeoutId = setTimeout(() => {
					cleanup();
					resolve(defaultValue);
				}, opts.timeout);
			}

			pendingExtensionRequests.set(id, {
				resolve: (response) => {
					cleanup();
					resolve(parseResponse(response));
				},
				reject,
			});
			emit(id, body);
		});
	}

	const ui: ExtensionUIContext = {
		select: (title, options, opts) =>
			createDialogPromise<string | undefined>(
				opts,
				undefined,
				{ method: "select", title, options, timeout: opts?.timeout },
				(r) => ("cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined),
			),

		confirm: (title, message, opts) =>
			createDialogPromise<boolean>(
				opts,
				false,
				{ method: "confirm", title, message, timeout: opts?.timeout },
				(r) => ("cancelled" in r && r.cancelled ? false : "confirmed" in r ? r.confirmed : false),
			),

		input: (title, placeholder, opts) =>
			createDialogPromise<string | undefined>(
				opts,
				undefined,
				{ method: "input", title, placeholder, timeout: opts?.timeout },
				(r) => ("cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined),
			),

		notify(message: string, type?: "info" | "warning" | "error"): void {
			// Fire and forget — no response needed.
			emit(randomUUID(), { method: "notify", message, notifyType: type });
		},

		onTerminalInput(): () => void {
			// Raw terminal input not serializable — stays a no-op in the daemon.
			return () => {};
		},

		setStatus(key: string, text: string | undefined): void {
			emit(randomUUID(), { method: "setStatus", statusKey: key, statusText: text });
		},

		setWorkingMessage(_message?: string): void {
			// Working message requires TUI loader access — client-only.
		},

		setWorkingVisible(_visible: boolean): void {
			// Working visibility requires TUI loader access — client-only.
		},

		setWorkingIndicator(_options?: WorkingIndicatorOptions): void {
			// Working indicator customization requires TUI loader access — client-only.
		},

		setHiddenThinkingLabel(_label?: string): void {
			// Hidden thinking label requires TUI message-rendering access — client-only.
		},

		setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
			// Only string arrays are serializable — component factories are ignored in the daemon.
			if (content === undefined || Array.isArray(content)) {
				emit(randomUUID(), {
					method: "setWidget",
					widgetKey: key,
					widgetLines: content as string[] | undefined,
					widgetPlacement: options?.placement,
				});
			}
		},

		setFooter(_factory: unknown): void {
			// Custom footer is a component factory — not serializable.
		},

		setHeader(_factory: unknown): void {
			// Custom header is a component factory — not serializable.
		},

		setTitle(title: string): void {
			emit(randomUUID(), { method: "setTitle", title });
		},

		async custom() {
			// Custom UI is a component factory — not serializable.
			return undefined as never;
		},

		pasteToEditor(text: string): void {
			// No paste handling over the wire — fall back to setEditorText, as pi does.
			this.setEditorText(text);
		},

		setEditorText(text: string): void {
			emit(randomUUID(), { method: "setEditorText", text });
		},

		getEditorText(): string {
			// Synchronous read can't round-trip; the client tracks editor state locally.
			return "";
		},

		async editor(title: string, prefill?: string): Promise<string | undefined> {
			// NOTE: unlike the dialogs above, pi parks this promise with no abort/timeout, so it would
			// hang forever if the answering client disconnected — `cancelAllPending()` resolves it.
			const id = randomUUID();
			return new Promise((resolve, reject) => {
				pendingExtensionRequests.set(id, {
					resolve: (response) => {
						if ("cancelled" in response && response.cancelled) resolve(undefined);
						else if ("value" in response) resolve(response.value);
						else resolve(undefined);
					},
					reject,
				});
				emit(id, { method: "editor", title, prefill });
			});
		},

		addAutocompleteProvider(): void {
			// Autocomplete provider composition is a function — not serializable.
		},

		setEditorComponent(): void {
			// Custom editor components are factories — not serializable.
		},

		getEditorComponent() {
			return undefined;
		},

		// Theme rendering is a client concern; the daemon stays data-only/inert here (returning the
		// engine theme singleton, as pi's rpc context and steward's noOpUIContext both do).
		get theme() {
			return theme;
		},

		getAllThemes() {
			return [];
		},

		getTheme(_name: string) {
			return undefined;
		},

		setTheme(_theme: string | Theme) {
			return { success: false, error: "Theme switching is a client concern in daemon mode." };
		},

		getToolsExpanded() {
			return false;
		},

		setToolsExpanded(_expanded: boolean) {
			// Tool expansion is a client-TUI concern.
		},
	};

	return {
		ui,
		resolveUiResponse(response: ExtensionUIResponse): void {
			const parked = pendingExtensionRequests.get(response.id);
			if (parked) {
				pendingExtensionRequests.delete(response.id);
				parked.resolve(response);
			}
		},
		cancelAllPending(): void {
			// Snapshot first: each resolve() runs the dialog's cleanup, which deletes from the map.
			const entries = [...pendingExtensionRequests.entries()];
			pendingExtensionRequests.clear();
			for (const [id, parked] of entries) {
				parked.resolve({ type: "extension_ui_response", id, cancelled: true });
			}
		},
	};
}
