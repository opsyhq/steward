/**
 * Per-agent session open/resume.
 *
 * A minimal session manager: the engine's `JsonlSessionRepo` already provides the
 * durable, append-only session tree. Sessions are keyed by AGENT, not by the
 * user's cwd (see the key-by-agent note below).
 */

import type { Message, TextContent } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@opsyhq/agent";
import { type JsonlSessionMetadata, JsonlSessionRepo, type Session } from "@opsyhq/agent";
import { NodeExecutionEnv } from "@opsyhq/agent/node";
import { getSessionsDir, getWorkspaceDir } from "../config.ts";
import type { DaemonSessionDetail } from "../types.ts";

export interface OpenAgentSessionOptions {
	/** Start a fresh session instead of resuming the latest. */
	fresh?: boolean;
	/** Resume a specific stored session by id instead of the latest. Ignored when `fresh` is set. */
	id?: string;
}

export interface OpenAgentSessionResult {
	repo: JsonlSessionRepo;
	session: Session<JsonlSessionMetadata>;
	env: NodeExecutionEnv;
	cwd: string;
}

/** One stored session for an agent — the `id` is what `openAgentSession({ id })` / `listSessions` use. */
export interface SessionInfo {
	id: string;
	createdAt: string;
	/** The session's folded tags. Populated by `findSessions`; `{}` from the plain `listSessions` listing. */
	tags: Record<string, string>;
}

export async function openAgentSession(
	name: string,
	options: OpenAgentSessionOptions = {},
): Promise<OpenAgentSessionResult> {
	// Key-by-agent: always use the agent's own workspace as cwd, so the repo's
	// encodeCwd() resolves to one constant subdir per agent — sessions never
	// scatter by whatever directory the user happened to run `wolli` from.
	const cwd = getWorkspaceDir(name);
	const env = new NodeExecutionEnv({ cwd });
	const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: getSessionsDir(name) });

	// Resume a specific stored session by id, matched off the repo's listing.
	if (options.id) {
		const existing = await repo.list({ cwd });
		const match = existing.find((metadata) => metadata.id === options.id);
		if (!match) throw new Error(`No session "${options.id}" for agent "${name}"`);
		return { repo, session: await repo.open(match), env, cwd };
	}

	if (!options.fresh) {
		const existing = await repo.list({ cwd });
		if (existing.length > 0) {
			const session = await repo.open(existing[0]);
			return { repo, session, env, cwd };
		}
	}

	const session = await repo.create({ cwd });
	return { repo, session, env, cwd };
}

/** Stored sessions for an agent, as `repo.list` returns them (newest first). */
export async function listAgentSessions(name: string): Promise<SessionInfo[]> {
	const cwd = getWorkspaceDir(name);
	const env = new NodeExecutionEnv({ cwd });
	const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: getSessionsDir(name) });
	const metadatas = await repo.list({ cwd });
	return metadatas.map((metadata) => ({ id: metadata.id, createdAt: metadata.createdAt, tags: {} }));
}

function isMessageWithContent(message: AgentMessage): message is Message {
	return typeof (message as Message).role === "string" && "content" in message;
}

function extractTextContent(message: Message): string {
	const content = message.content;
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join(" ");
}

/**
 * Open one stored session and derive its rich `DaemonSessionDetail`. Field semantics mirror the
 * coding-agent `buildSessionInfo`: `messageCount` counts all message entries; `firstMessage` is the first
 * user text (else "(no messages)"); `allMessagesText` is the full user+assistant transcript joined (what
 * backs the selector's search); `modifiedAt` is the last message activity, falling back to `createdAt`.
 */
async function buildSessionDetail(
	session: Session<JsonlSessionMetadata>,
	metadata: JsonlSessionMetadata,
): Promise<DaemonSessionDetail> {
	const entries = await session.getEntries();
	let messageCount = 0;
	let firstMessage = "";
	const allMessages: string[] = [];
	let lastActivityTime: number | undefined;

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		messageCount++;

		const message = entry.message;
		const entryTime = new Date(entry.timestamp).getTime();
		if (!Number.isNaN(entryTime)) {
			lastActivityTime = Math.max(lastActivityTime ?? 0, entryTime);
		}

		if (!isMessageWithContent(message)) continue;
		if (message.role !== "user" && message.role !== "assistant") continue;

		const textContent = extractTextContent(message);
		if (!textContent) continue;

		allMessages.push(textContent);
		if (!firstMessage && message.role === "user") {
			firstMessage = textContent;
		}
	}

	const name = (await session.getSessionName())?.trim() || undefined;
	const modified =
		typeof lastActivityTime === "number" && lastActivityTime > 0
			? new Date(lastActivityTime)
			: new Date(metadata.createdAt);

	return {
		sessionId: metadata.id,
		sessionFile: metadata.path,
		parentSessionFile: metadata.parentSessionPath,
		cwd: metadata.cwd,
		createdAt: metadata.createdAt,
		modifiedAt: modified.toISOString(),
		name,
		messageCount,
		firstMessage: firstMessage || "(no messages)",
		allMessagesText: allMessages.join(" "),
	};
}

/**
 * Stored sessions for an agent with the rich fields the resume selector renders. Opens every session to
 * read its transcript (fine for the handful per agent, same cost pattern as `findSessions`), so this is
 * NOT on the hot snapshot path — it backs `GET /sessions/detail`, fetched once when the selector opens.
 */
export async function listAgentSessionsDetail(name: string): Promise<DaemonSessionDetail[]> {
	const cwd = getWorkspaceDir(name);
	const env = new NodeExecutionEnv({ cwd });
	const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: getSessionsDir(name) });
	const metadatas = await repo.list({ cwd });
	const details: DaemonSessionDetail[] = [];
	for (const metadata of metadatas) {
		details.push(await buildSessionDetail(await repo.open(metadata), metadata));
	}
	return details;
}

/** Rename a stored session by id — appends a `session_info` entry, the same primitive a live session uses. */
export async function renameAgentSession(name: string, id: string, sessionName: string): Promise<void> {
	const { session } = await openAgentSession(name, { id });
	await session.appendSessionName(sessionName);
}

/** Delete a stored session's JSONL file by id. Throws when no session matches. */
export async function deleteAgentSession(name: string, id: string): Promise<void> {
	const cwd = getWorkspaceDir(name);
	const env = new NodeExecutionEnv({ cwd });
	const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: getSessionsDir(name) });
	const metadatas = await repo.list({ cwd });
	const match = metadatas.find((metadata) => metadata.id === id);
	if (!match) throw new Error(`No session "${id}" for agent "${name}"`);
	await repo.delete(match);
}
