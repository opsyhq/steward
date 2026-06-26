/**
 * Daemon health + shutdown probes over the loopback HTTP wire.
 *
 * A daemon is now found and lifecycled by its fixed `http://host:port` base (from agent.json), not a
 * pid: `isHealthy` probes the unauthed `/health`; `waitForHealth`/`waitForShutdown` poll it until the
 * daemon is up/down; `requestDaemonShutdown` asks a running daemon to self-exit (the pid-free
 * replacement for SIGTERM). Lives in its own module so both the client and the `none` service backend
 * can use these without a client <-> service import cycle.
 */

import type { DaemonAgentState } from "../types.ts";

const HEALTH_TIMEOUT_MS = 15_000;
const HEALTH_POLL_MS = 150;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `GET /health` (no auth) answers `{status:"ok"}` while the daemon is listening. */
export async function isHealthy(base: string): Promise<boolean> {
	try {
		const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) });
		if (!response.ok) return false;
		const body = (await response.json()) as { status?: string };
		return body.status === "ok";
	} catch {
		return false;
	}
}

/** Poll `/health` until the daemon at `base` is listening (or time out). */
export async function waitForHealth(base: string): Promise<void> {
	const deadline = Date.now() + HEALTH_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (await isHealthy(base)) return;
		await sleep(HEALTH_POLL_MS);
	}
	throw new Error(`Daemon at ${base} did not become healthy within ${HEALTH_TIMEOUT_MS / 1000}s.`);
}

/** Poll `/health` until the daemon at `base` stops responding (or time out) — the port is then free. */
export async function waitForShutdown(base: string): Promise<void> {
	const deadline = Date.now() + HEALTH_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (!(await isHealthy(base))) return;
		await sleep(HEALTH_POLL_MS);
	}
	throw new Error(`Daemon at ${base} did not shut down within ${HEALTH_TIMEOUT_MS / 1000}s.`);
}

/**
 * Best-effort: ask a running daemon to self-exit. The `shutdown` verb is session-scoped on the wire,
 * so find any session via `GET /sessions` and post it there. Swallows every error — a daemon that is
 * already gone (or never came up) is the success case for the callers (delete/restart/stop).
 */
export async function requestDaemonShutdown(base: string, token: string): Promise<void> {
	try {
		const list = await fetch(`${base}/sessions`, {
			headers: { authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(2000),
		});
		if (!list.ok) return;
		const body = (await list.json()) as DaemonAgentState;
		const sessionId = body.sessions[0]?.sessionId;
		if (!sessionId) return;
		await fetch(`${base}/sessions/${sessionId}/control`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
			body: JSON.stringify({ type: "shutdown" }),
			signal: AbortSignal.timeout(2000),
		});
	} catch {
		// Best-effort: the daemon is already down or unreachable.
	}
}
