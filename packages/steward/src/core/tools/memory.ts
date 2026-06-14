/**
 * The `self_update` tool — durable edits to the agent's curated
 * SOUL.md / MEMORY.md / USER.md.
 *
 * Mirrors coding-agent's tool-factory convention (`createReadTool` →
 * `createSelfUpdateTool`): one factory bound to a cwd/agent, returning an
 * `AgentTool`. Operations (add/replace/remove) are modeled on hermes' memory
 * tool. Writes are durable immediately but only enter the system prompt on the
 * NEXT session (frozen-snapshot rule), so results say "effective next session".
 *
 * Budget overflow, ambiguous matches, and missing matches are returned as normal
 * tool content (no throw, no write) so the model can adjust.
 */

import type { AgentTool, AgentToolResult } from "@opsyhq/agent";
import { type Static, Type } from "typebox";
import { getMemoryPath, getSoulPath, getUserMemoryPath } from "../../config.ts";
import { MEMORY_BUDGET, readMemoryFile, SOUL_BUDGET, USER_BUDGET, writeMemoryFile } from "../memory.ts";

const selfUpdateSchema = Type.Object({
	file: Type.Union([Type.Literal("SOUL"), Type.Literal("MEMORY"), Type.Literal("USER")], {
		description:
			"Which curated file to edit: SOUL (who you are / what you're for), MEMORY (your own notebook), or USER (facts about the user).",
	}),
	op: Type.Union([Type.Literal("add"), Type.Literal("replace"), Type.Literal("remove")], {
		description:
			"add: append content as a new line. replace: swap the line matching `match` (or the whole file if `match` is omitted). remove: delete the line matching `match`.",
	}),
	content: Type.Optional(
		Type.String({ description: "Text to add, or to replace with. Required for add and replace." }),
	),
	match: Type.Optional(
		Type.String({
			description: "Substring identifying the line to replace/remove. Omit on replace to overwrite the whole file.",
		}),
	),
});

export type SelfUpdateToolInput = Static<typeof selfUpdateSchema>;

export interface SelfUpdateToolDetails {
	file: "SOUL" | "MEMORY" | "USER";
	op: "add" | "replace" | "remove";
	applied: boolean;
	bytes?: number;
}

type OpOutcome = { ok: true; content: string } | { ok: false; message: string };
type SelfUpdateFile = SelfUpdateToolDetails["file"];

function describeAmbiguous(file: string, match: string, matched: string[]): string {
	const previews = matched
		.slice(0, 5)
		.map((line) => `  - ${line.trim()}`)
		.join("\n");
	return `"${match}" matches ${matched.length} lines in ${file}.md; be more specific:\n${previews}`;
}

function applySelfUpdateOp(file: string, current: string, params: SelfUpdateToolInput): OpOutcome {
	const { op, content, match } = params;

	if (op === "add") {
		const addition = (content ?? "").trim();
		if (!addition) return { ok: false, message: "add requires non-empty content." };
		const base = current.replace(/\n+$/, "");
		return { ok: true, content: base.length === 0 ? `${addition}\n` : `${base}\n${addition}\n` };
	}

	if (op === "replace" && (match === undefined || match === "")) {
		const replacement = (content ?? "").trim();
		return { ok: true, content: replacement.length === 0 ? "" : `${replacement}\n` };
	}

	if (match === undefined || match === "") {
		return { ok: false, message: `${op} requires a \`match\` substring.` };
	}

	const lines = current.split("\n");
	const matched = lines.filter((line) => line.includes(match));
	if (matched.length === 0) return { ok: false, message: `No line in ${file}.md contains "${match}".` };
	if (matched.length > 1) return { ok: false, message: describeAmbiguous(file, match, matched) };

	if (op === "replace") {
		const replacement = content ?? "";
		return { ok: true, content: lines.map((line) => (line.includes(match) ? replacement : line)).join("\n") };
	}

	// remove
	return { ok: true, content: lines.filter((line) => !line.includes(match)).join("\n") };
}

function textResult(text: string, details: SelfUpdateToolDetails): AgentToolResult<SelfUpdateToolDetails> {
	return { content: [{ type: "text", text }], details };
}

function targetForFile(name: string, file: SelfUpdateFile): { path: string; budget: number } {
	switch (file) {
		case "SOUL":
			return { path: getSoulPath(name), budget: SOUL_BUDGET };
		case "MEMORY":
			return { path: getMemoryPath(name), budget: MEMORY_BUDGET };
		case "USER":
			return { path: getUserMemoryPath(name), budget: USER_BUDGET };
	}
}

export function createSelfUpdateTool(name: string): AgentTool<typeof selfUpdateSchema, SelfUpdateToolDetails> {
	return {
		name: "self_update",
		label: "Self",
		description:
			"Edit your curated self-maintenance files. SOUL.md is who you are and what you're for; " +
			"USER.md holds facts about your human; MEMORY.md is your durable working notes. " +
			"Edits are saved immediately but only appear in your prompt on your next session. Keep entries concise.",
		parameters: selfUpdateSchema,
		executionMode: "sequential",
		execute: async (_toolCallId, params) => {
			const { path, budget } = targetForFile(name, params.file);
			const current = readMemoryFile(path);

			const outcome = applySelfUpdateOp(params.file, current, params);
			if (!outcome.ok) {
				return textResult(outcome.message, { file: params.file, op: params.op, applied: false });
			}

			if (outcome.content.length > budget) {
				return textResult(
					`Not saved: ${params.file}.md would be ${outcome.content.length} chars, over the ${budget} budget. ` +
						"Remove or shorten existing entries first.",
					{ file: params.file, op: params.op, applied: false },
				);
			}

			writeMemoryFile(path, outcome.content);
			return textResult(`Saved to ${params.file}.md. Effective next session.`, {
				file: params.file,
				op: params.op,
				applied: true,
				bytes: outcome.content.length,
			});
		},
	};
}

export const createMemoryTool = createSelfUpdateTool;
export type MemoryToolInput = SelfUpdateToolInput;
export type MemoryToolDetails = SelfUpdateToolDetails;
