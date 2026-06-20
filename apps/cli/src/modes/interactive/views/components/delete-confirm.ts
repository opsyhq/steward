/**
 * Type-the-name delete confirmation, shared by the dashboard and the agent detail page. It shows the
 * target agent, makes the operator retype its name, then tears it down via `Agent.delete()`. A name
 * mismatch or a failed delete surfaces inline and stays put; `onCancel`/`onDeleted` hand control back
 * to the host view (which owns what happens next — re-list, navigate home, etc.).
 */

import { type Agent, theme } from "@opsyhq/steward";
import { Container, Input, matchesKey, Spacer, Text } from "@opsyhq/tui";

export interface DeleteConfirmCallbacks {
	/** Esc: abandon the delete, return to the host view unchanged. */
	onCancel: () => void;
	/** The agent's home is gone; the host decides where to go next. */
	onDeleted: () => void;
	/** Repaint after a keystroke or an inline status change (differential). */
	requestRender: () => void;
}

export class DeleteConfirm extends Container {
	private readonly agent: Agent;
	private readonly callbacks: DeleteConfirmCallbacks;
	private readonly input = new Input();
	private readonly status = new Text("", 1, 0);

	constructor(agent: Agent, callbacks: DeleteConfirmCallbacks) {
		super();
		this.agent = agent;
		this.callbacks = callbacks;
		// Container isn't Focusable, so focus won't reach the input — show its cursor by hand.
		this.input.focused = true;

		this.addChild(new Text(theme.fg("accent", `Delete agent "${agent.name}"`), 1, 0));
		this.addChild(new Text(theme.fg("dim", "This removes its memory, sessions, and workspace."), 1, 0));
		this.addChild(new Text(theme.fg("dim", `Type ${agent.name} to confirm:`), 1, 0));
		this.addChild(this.input);
		this.addChild(this.status);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "enter delete · esc cancel"), 1, 0));
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.callbacks.onCancel();
			return;
		}
		if (matchesKey(data, "enter")) {
			this.submit();
			return;
		}
		this.input.handleInput(data);
		this.callbacks.requestRender();
	}

	private submit(): void {
		// Type-the-name gate: Enter only fires the delete on an exact match.
		if (this.input.getValue().trim() !== this.agent.name) {
			this.status.setText(theme.fg("warning", `Name doesn't match. Type ${this.agent.name} to confirm.`));
			this.callbacks.requestRender();
			return;
		}
		const result = this.agent.delete();
		if (!result.ok) {
			this.status.setText(theme.fg("warning", result.error ?? "Delete failed."));
			this.callbacks.requestRender();
			return;
		}
		this.callbacks.onDeleted();
	}
}
