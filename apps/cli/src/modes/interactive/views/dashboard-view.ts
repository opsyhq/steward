/**
 * Dashboard page: a `SelectList` of agents (`steward.list()`, no daemon). Press `n` to create one
 * inline (then drop into its birth chat), or `d` to delete the highlighted one after a type-the-name
 * confirm.
 *
 * Layout is a fixed skeleton built once in `onMount`: a stable `listContainer` (rebuilt only when the
 * agent set changes) and a stable `actionContainer` (swapped per mode). State changes mutate one
 * region and lean on the TUI's differential render — no whole-view clear, no forced repaint.
 */

import { getSelectListTheme, theme } from "@opsyhq/steward";
import { type Component, Container, Input, matchesKey, type SelectItem, SelectList, Spacer, Text } from "@opsyhq/tui";
import { type AppView, BIRTH_OPENER, type ViewContext } from "../app.ts";
import { DeleteConfirm } from "./components/delete-confirm.ts";

type Mode = "browse" | "creating" | "deleting";

export class DashboardView extends Container implements AppView {
	private ctx!: ViewContext;
	private readonly listContainer = new Container();
	private readonly actionContainer = new Container();
	private list?: SelectList;
	private mode: Mode = "browse";
	private input?: Input;
	private status?: Text;
	private deleteConfirm?: DeleteConfirm;

	onMount(ctx: ViewContext): void {
		this.ctx = ctx;
		this.addChild(new Text(theme.bold("Agents"), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(this.actionContainer);
		this.renderList();
		this.renderAction();
	}

	/** Rebuild the agent list. Runs once on mount, then only when the set changes (after a delete). */
	private renderList(): void {
		this.listContainer.clear();
		const items: SelectItem[] = this.ctx.steward.list().map((agent) => ({
			value: agent.name,
			label: agent.name,
			description: agent.config.purpose.trim().replace(/\s+/g, " "),
		}));
		if (items.length === 0) {
			this.list = undefined;
			this.listContainer.addChild(new Text(theme.fg("dim", "No agents yet."), 1, 0));
			return;
		}
		this.list = new SelectList(items, 12, getSelectListTheme());
		this.list.onSelect = (item) => void this.ctx.navigate({ to: "chat", name: item.value });
		this.listContainer.addChild(this.list);
	}

	/** Swap the bottom region to match the current mode. */
	private renderAction(): void {
		this.actionContainer.clear();

		if (this.mode === "creating") {
			this.input = new Input();
			// Container isn't Focusable, so focus won't reach the input — show its cursor by hand.
			this.input.focused = true;
			this.status = new Text("", 1, 0);
			this.actionContainer.addChild(new Text(theme.fg("accent", "New agent"), 1, 0));
			this.actionContainer.addChild(this.input);
			this.actionContainer.addChild(this.status);
			this.actionContainer.addChild(new Spacer(1));
			this.actionContainer.addChild(new Text(theme.fg("dim", "enter create · esc cancel"), 1, 0));
			return;
		}

		if (this.mode === "deleting" && this.deleteConfirm) {
			this.actionContainer.addChild(this.deleteConfirm);
			return;
		}

		const browseKeys = this.list ? "enter chat · tab/→ details · d delete · " : "";
		this.actionContainer.addChild(new Text(theme.fg("dim", `${browseKeys}n new · q quit`), 1, 0));
	}

	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+c")) {
			this.ctx.quit();
			return;
		}

		if (this.mode === "creating") {
			if (matchesKey(data, "escape")) {
				this.cancelCreate();
			} else if (matchesKey(data, "enter")) {
				this.submitCreate();
			} else {
				this.input?.handleInput(data);
				this.ctx.tui.requestRender();
			}
			return;
		}

		if (this.mode === "deleting") {
			this.deleteConfirm?.handleInput(data);
			return;
		}

		if (data === "q") {
			this.ctx.quit();
			return;
		}
		if (data === "n") {
			this.mode = "creating";
			this.renderAction();
			this.ctx.tui.requestRender();
			return;
		}
		if (data === "d") {
			const selected = this.list?.getSelectedItem();
			if (!selected) return; // Empty list / no selection: nothing to delete.
			const agent = this.ctx.steward.get(selected.value);
			if (!agent) return;

			this.mode = "deleting";
			this.deleteConfirm = new DeleteConfirm(agent, {
				onCancel: () => {
					this.mode = "browse";
					this.deleteConfirm = undefined;
					this.renderAction();
					this.ctx.tui.requestRender();
				},
				onDeleted: () => {
					this.mode = "browse";
					this.deleteConfirm = undefined;
					// The deleted agent drops out of the list — that's the confirmation.
					this.renderList();
					this.renderAction();
					this.ctx.tui.requestRender();
				},
				requestRender: () => this.ctx.tui.requestRender(),
			});
			this.renderAction();
			this.ctx.tui.requestRender();
			return;
		}
		if (matchesKey(data, "tab") || matchesKey(data, "right")) {
			const selected = this.list?.getSelectedItem();
			if (selected) void this.ctx.navigate({ to: "agent", name: selected.value });
			return;
		}
		this.list?.handleInput(data);
	}

	private cancelCreate(): void {
		this.mode = "browse";
		this.input = undefined;
		this.status = undefined;
		this.renderAction();
		this.ctx.tui.requestRender();
	}

	private submitCreate(): void {
		const name = this.input?.getValue().trim() ?? "";
		if (name.length === 0) return; // Enter on a blank field: no-op, not an error.
		// create() validates the name and rejects collisions; catch surfaces that (and IO errors) without
		// crashing the synchronous input dispatch.
		try {
			const agent = this.ctx.steward.create(name);
			void this.ctx.navigate({ to: "chat", name: agent.name, initialAssistantMessage: BIRTH_OPENER });
		} catch (error) {
			this.status?.setText(theme.fg("warning", error instanceof Error ? error.message : String(error)));
			this.ctx.tui.requestRender();
		}
	}

	focusTarget(): Component {
		return this;
	}

	onUnmount(): void {}
}
