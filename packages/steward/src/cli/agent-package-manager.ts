/**
 * Construct a `DefaultPackageManager` bound to one agent's per-agent home.
 *
 * Mirrors coding-agent's `package-manager-cli.ts`, where the CLI owns creating the
 * package manager. Steward's twist is the explicit `<agent>` argument: the agent's home
 * (`~/.steward/agents/<name>`) is BOTH the install root and the settings location, so
 * installs and the persisted `packages[]` land in the per-agent `settings.json` (never
 * the shared dir). `cwd` is the user's shell cwd so relative local sources (e.g.
 * `./examples/...`) resolve from where the command was typed; the package manager
 * normalizes them to agent-relative before persisting, so they round-trip on launch.
 */

import { getAgentDir } from "../config.ts";
import { DefaultPackageManager } from "../core/package-manager.ts";
import { SettingsManager } from "../core/settings-manager.ts";

export interface AgentPackageManager {
	agentDir: string;
	settingsManager: SettingsManager;
	packageManager: DefaultPackageManager;
}

export function createAgentPackageManager(agentName: string): AgentPackageManager {
	const agentDir = getAgentDir(agentName);
	const cwd = process.cwd();
	// SettingsManager's "global" scope path is `<agentDir>/settings.json`, so packages[]
	// persists per-agent.
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
	return { agentDir, settingsManager, packageManager };
}
