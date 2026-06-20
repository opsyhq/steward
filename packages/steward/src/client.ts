/**
 * The `@opsyhq/steward` client surface — a three-level hierarchy on one entry point:
 *
 *   - `Steward`      — the agent collection (`list`, `get`, `create`).
 *   - `Agent`        — one agent: its registry data (`config`) + lifecycle (`delete`) and the
 *                      session factory (`open`/`attach`).
 *   - `AgentSession` — the live per-agent daemon connection (see `agent-session.ts`).
 *
 * `Steward`/`Agent` are thin handles over the stateless `core/agent-config.ts` registry functions
 * plus the on-demand daemon spawn: `Agent.open` finds a live daemon via the temp config + `/health`,
 * or spawns a detached `daemon <name>` (the same launch command the OS service unit runs) and waits
 * for it to come up.
 */

import { spawn } from "node:child_process";
import { AgentSession, isHealthy, waitForHealth } from "./agent-session.ts";
import {
	type AgentConfig,
	agentExists,
	createAgent,
	deleteAgent,
	listAgents,
	loadAgentConfig,
} from "./core/agent-config.ts";
import { deleteDaemonConfig, loadDaemonConfig } from "./core/daemon-config.ts";
import { daemonLaunchCommand, getServiceManager } from "./core/service/service-manager.ts";

/** Top level: the agent collection on disk. Holds no required state. */
export class Steward {
	/** Every agent under the agents root, as handles. */
	list(): Agent[] {
		return listAgents().map((config) => new Agent(config));
	}

	/** A handle for `name` if it exists on disk, else `undefined`. */
	get(name: string): Agent | undefined {
		if (!agentExists(name)) return undefined;
		return new Agent(loadAgentConfig(name));
	}

	/** Create the agent's home tree and return its handle. */
	create(name: string, opts: { purpose?: string; model?: string } = {}): Agent {
		return new Agent(createAgent({ name, ...opts }));
	}
}

/** One agent: its registry data plus per-agent lifecycle and the session factory. */
export class Agent {
	readonly config: AgentConfig;

	constructor(config: AgentConfig) {
		this.config = config;
	}

	get name(): string {
		return this.config.name;
	}

	/**
	 * Resolve the agent's daemon (config → /health) and attach, spawning a detached daemon if none is
	 * live. The spawn reuses `daemonLaunchCommand` — the same command the OS service unit runs — so it
	 * works on any backend: a transient, on-demand daemon, independent of the supervised unit that
	 * only exists post-deploy.
	 */
	async open(): Promise<AgentSession> {
		const existing = loadDaemonConfig(this.name);
		if (existing && (await isHealthy(existing.port))) {
			return AgentSession.attach(`http://127.0.0.1:${existing.port}`, existing.token);
		}

		// Not live → spawn `steward daemon <name>` detached. `steward` is not on PATH in dev, so the
		// launch command goes through the running binary (process.execPath + the resolved cli off argv[1]).
		const [command, ...commandArgs] = daemonLaunchCommand(this.name);
		const child = spawn(command, commandArgs, { detached: true, stdio: "ignore" });
		child.unref();

		const config = await waitForHealth(this.name);
		return AgentSession.attach(`http://127.0.0.1:${config.port}`, config.token);
	}

	/** Attach to a known, already-running daemon endpoint. */
	attach(base: string, token: string): Promise<AgentSession> {
		return AgentSession.attach(base, token);
	}

	/**
	 * Tear the agent down: uninstall the OS service (so a supervised daemon won't relaunch), SIGTERM
	 * any daemon still running (a birth daemon has no unit but is a live process), delete the home
	 * dir, then drop the daemon config. `deleteAgent` touches only the agent home — never the shared
	 * credential dir.
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

		const result = deleteAgent(this.name);
		if (result.ok) deleteDaemonConfig(this.name);
		return result;
	}
}
