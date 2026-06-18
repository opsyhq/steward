/**
 * DaemonUIContext unit tests — the parked-promise machinery in isolation (no daemon, no SSE):
 * a dialog emits one request frame and resolves on the matching `/ui-response`; a cancelled
 * response (or a dropped client, via `cancelAllPending`) resolves to the default; the wire
 * `method` strings are all camelCase (notably `setEditorText`, normalized off pi's snake_case).
 */

import { describe, expect, it } from "vitest";
import type { ExtensionUIRequest } from "../src/modes/daemon/daemon-types.ts";
import { createDaemonUIContext } from "../src/modes/daemon/daemon-ui-context.ts";

function setup() {
	const frames: ExtensionUIRequest[] = [];
	const ctx = createDaemonUIContext((frame) => frames.push(frame));
	return { frames, ctx };
}

describe("createDaemonUIContext", () => {
	it("round-trips select: emits one request, resolves on the matching response", async () => {
		const { frames, ctx } = setup();
		const pending = ctx.ui.select("Pick", ["a", "b"]);

		expect(frames).toHaveLength(1);
		expect(frames[0]).toMatchObject({
			type: "extension_ui_request",
			method: "select",
			title: "Pick",
			options: ["a", "b"],
		});
		expect(typeof frames[0].id).toBe("string");

		ctx.resolveUiResponse({ type: "extension_ui_response", id: frames[0].id, value: "b" });
		expect(await pending).toBe("b");
	});

	it("resolves confirm and input from their response arms", async () => {
		const { frames, ctx } = setup();

		const confirmed = ctx.ui.confirm("Sure?", "really");
		ctx.resolveUiResponse({ type: "extension_ui_response", id: frames[0].id, confirmed: true });
		expect(await confirmed).toBe(true);

		frames.length = 0;
		const value = ctx.ui.input("Name", "placeholder");
		ctx.resolveUiResponse({ type: "extension_ui_response", id: frames[0].id, value: "Ada" });
		expect(await value).toBe("Ada");
	});

	it("a cancelled response resolves a dialog to its default", async () => {
		const { frames, ctx } = setup();
		const selection = ctx.ui.select("Pick", ["a"]);
		ctx.resolveUiResponse({ type: "extension_ui_response", id: frames[0].id, cancelled: true });
		expect(await selection).toBeUndefined();
	});

	it("cancelAllPending resolves a parked editor to undefined (the client-disconnect path)", async () => {
		const { frames, ctx } = setup();
		const editing = ctx.ui.editor("Edit", "seed");
		expect(frames[0]).toMatchObject({ method: "editor", title: "Edit", prefill: "seed" });

		// pi parks editor() with no abort/timeout — only an explicit cancel can unstick it.
		ctx.cancelAllPending();
		expect(await editing).toBeUndefined();
	});

	it("a timeout resolves a dialog to its default with no response", async () => {
		const { ctx } = setup();
		expect(await ctx.ui.select("Pick", ["a"], { timeout: 5 })).toBeUndefined();
	});

	it("normalizes setEditorText to camelCase (not pi's snake_case set_editor_text)", () => {
		const { frames, ctx } = setup();
		ctx.ui.setEditorText("hello");
		expect(frames[0]).toMatchObject({ method: "setEditorText", text: "hello" });
	});

	it("fire-and-forget methods emit a frame and never park a promise", () => {
		const { frames, ctx } = setup();
		ctx.ui.notify("hi", "warning");
		ctx.ui.setStatus("key", "value");
		ctx.ui.setTitle("Title");
		ctx.ui.setWidget("w", ["line"]);

		expect(frames.map((f) => f.method)).toEqual(["notify", "setStatus", "setTitle", "setWidget"]);
		// Nothing parked → cancelAllPending has nothing to resolve and must not throw.
		expect(() => ctx.cancelAllPending()).not.toThrow();
	});

	it("ignores a setWidget component factory (only string arrays are serializable)", () => {
		const { frames, ctx } = setup();
		(ctx.ui.setWidget as (k: string, c: unknown) => void)("w", () => ({}));
		expect(frames).toHaveLength(0);
	});
});
