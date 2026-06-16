/**
 * Bash Spawn Hook Example
 *
 * Adjusts command, cwd, and env before execution.
 *
 * Usage:
 *   steward -e ./bash-spawn-hook.ts
 */

import type { ExtensionAPI } from "@opsyhq/steward";
import { createBashTool } from "@opsyhq/steward";

export default function (steward: ExtensionAPI) {
	const cwd = process.cwd();

	const bashTool = createBashTool(cwd, {
		spawnHook: ({ command, cwd, env }) => ({
			command: `source ~/.profile\n${command}`,
			cwd,
			env: { ...env, STEWARD_SPAWN_HOOK: "1" },
		}),
	});

	steward.registerTool({
		...bashTool,
		execute: async (id, params, signal, onUpdate, _ctx) => {
			return bashTool.execute(id, params, signal, onUpdate);
		},
	});
}
