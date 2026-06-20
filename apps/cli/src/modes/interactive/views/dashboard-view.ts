/**
 * Dashboard page: a `SelectList` of agents (`steward.list()`, no daemon). Press `n` to create one
 * inline, then drop into its birth chat.
 */

import { getSelectListTheme, theme } from "@opsyhq/steward";
import { type Component, Container, Input, matchesKey, type SelectItem, SelectList, Spacer, Text } from "@opsyhq/tui";
import { type AppView, BIRTH_OPENER, type ViewContext } from "../app.ts";

export class DashboardView extends Container implements AppView {
	private ctx!: ViewContext;
	private list?: SelectList;
	private creating = false;
	private input?: Input;
	private status?: Text;

	onMount(ctx: ViewContext): void {
		this.ctx = ctx;
		this.renderContent();
	}

	private renderContent(): void {
		this.clear();
		this.addChild(new Text(theme.bold("Agents"), 1, 0));
		this.addChild(new Spacer(1));

		const items: SelectItem[] = this.ctx.steward.list().map((agent) => ({
			value: agent.name,
			label: agent.name,
			description: agent.config.purpose.trim().replace(/\s+/g, " "),
		}));

		if (items.length === 0) {
			this.list = undefined;
			this.addChild(new Text(theme.fg("dim", "No agents yet."), 1, 0));
		} else {
			this.list = new SelectList(items, 12, getSelectListTheme());
			this.list.onSelect = (item) => void this.ctx.navigate({ to: "chat", name: item.value });
			this.addChild(this.list);
		}
		this.addChild(new Spacer(1));

		if (this.creating) {
			this.renderCreate();
			return;
		}

		const browseKeys = items.length === 0 ? "" : "enter chat · tab/→ details · ";
		this.addChild(new Text(theme.fg("dim", `${browseKeys}n new · q quit`), 1, 0));
	}

	private renderCreate(): void {
		this.input = new Input();
		// Container isn't Focusable, so focus won't reach the input — show its cursor by hand.
		this.input.focused = true;
		this.status = new Text("", 1, 0);

		this.addChild(new Text(theme.fg("accent", "New agent"), 1, 0));
		this.addChild(this.input);
		this.addChild(this.status);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "enter create · esc cancel"), 1, 0));
	}

	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+c")) {
			this.ctx.quit();
			return;
		}

		if (this.creating) {
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

		if (data === "q") {
			this.ctx.quit();
			return;
		}
		if (data === "n") {
			this.creating = true;
			this.renderContent();
			this.ctx.tui.requestRender(true);
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
		this.creating = false;
		this.input = undefined;
		this.status = undefined;
		this.renderContent();
		this.ctx.tui.requestRender(true);
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
