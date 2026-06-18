/**
 * none backend — the unsupported-OS fallback (no launchd/systemd). There is no supervisor, so
 * `install`/`start` are inert: the daemon that handled deploy keeps running for this session, and a
 * client re-spawns one on demand (`DaemonSession.open`) rather than the backend supervising it.
 * `stop`/`isRunning` act directly on the descriptor's pid.
 */

import { deleteDaemonConfig, loadDaemonConfig } from "../daemon-config.ts";
import type { ServiceInstallOptions, ServiceManager } from "./service-manager.ts";

export class NoneServiceManager implements ServiceManager {
	readonly kind = "none" as const;

	install(_name: string, _opts?: ServiceInstallOptions): void {
		// No OS supervisor to register with — the already-running daemon serves the session.
	}

	uninstall(_name: string): void {
		// Nothing was registered.
	}

	start(_name: string, _opts?: ServiceInstallOptions): void {
		// No supervisor to start; the daemon lifecycle is the client's (DaemonSession.open) concern.
	}

	stop(name: string): void {
		const desc = loadDaemonConfig(name);
		if (!desc) return;
		try {
			process.kill(desc.pid, "SIGTERM");
		} catch {
			// Already gone — drop the stale descriptor so a future probe doesn't trust it.
			deleteDaemonConfig(name);
		}
	}

	isRunning(name: string): boolean {
		const desc = loadDaemonConfig(name);
		if (!desc) return false;
		try {
			process.kill(desc.pid, 0);
			return true;
		} catch {
			return false;
		}
	}
}
