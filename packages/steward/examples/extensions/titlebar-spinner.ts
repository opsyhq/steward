/**
 * Titlebar Spinner Extension
 *
 * Shows a braille spinner animation in the terminal title while the agent is working.
 * Uses `ctx.ui.setTitle()` to update the terminal title via the extension API.
 *
 * Usage:
 *   steward --extension examples/extensions/titlebar-spinner.ts
 */

import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@opsyhq/steward";

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function getBaseTitle(steward: ExtensionAPI): string {
	const cwd = path.basename(process.cwd());
	const session = steward.getSessionName();
	return session ? `Steward - ${session} - ${cwd}` : `Steward - ${cwd}`;
}

export default function (steward: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | null = null;
	let frameIndex = 0;

	function stopAnimation(ctx: ExtensionContext) {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		frameIndex = 0;
		ctx.ui.setTitle(getBaseTitle(steward));
	}

	function startAnimation(ctx: ExtensionContext) {
		stopAnimation(ctx);
		timer = setInterval(() => {
			const frame = BRAILLE_FRAMES[frameIndex % BRAILLE_FRAMES.length];
			const cwd = path.basename(process.cwd());
			const session = steward.getSessionName();
			const title = session ? `${frame} Steward - ${session} - ${cwd}` : `${frame} Steward - ${cwd}`;
			ctx.ui.setTitle(title);
			frameIndex++;
		}, 80);
	}

	steward.on("agent_start", async (_event, ctx) => {
		startAnimation(ctx);
	});

	steward.on("agent_end", async (_event, ctx) => {
		stopAnimation(ctx);
	});

	steward.on("session_shutdown", async (_event, ctx) => {
		stopAnimation(ctx);
	});
}
