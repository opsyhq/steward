import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commissionAgent, createAgent, loadAgentConfig } from "../src/core/agent-config.ts";
import { loadMemory, writeMemoryFile } from "../src/core/memory.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";
import { createSelfUpdateTool } from "../src/core/tools/memory.ts";
import { getSoulPath } from "../src/config.ts";

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "steward-test-"));
	process.env.STEWARD_HOME = home;
	createAgent({ name: "scribe", purpose: "Keep meeting notes" });
});

afterEach(() => {
	delete process.env.STEWARD_HOME;
	rmSync(home, { recursive: true, force: true });
});

describe("buildSystemPrompt", () => {
	it("includes the agent name and purpose", () => {
		const prompt = buildSystemPrompt({ config: loadAgentConfig("scribe") });
		expect(prompt).toContain("You are scribe");
		expect(prompt).toContain("Keep meeting notes");
	});

	it("renders the self-maintained file sections when empty", () => {
		const prompt = buildSystemPrompt({ config: loadAgentConfig("scribe"), soul: "", memory: "", user: "" });
		expect(prompt).toContain("### SOUL.md");
		expect(prompt).toContain("### MEMORY.md");
		expect(prompt).toContain("### USER.md");
	});

	it("includes delimited, read-only self-maintained files when present", () => {
		const prompt = buildSystemPrompt({
			config: loadAgentConfig("scribe"),
			soul: "soul fact",
			memory: "remembered fact",
			user: "user fact",
		});
		expect(prompt).toContain("read-only this session");
		expect(prompt).toContain("effective next session");
		expect(prompt).toContain("### SOUL.md");
		expect(prompt).toContain("soul fact");
		expect(prompt).toContain("### MEMORY.md");
		expect(prompt).toContain("remembered fact");
		expect(prompt).toContain("### USER.md");
		expect(prompt).toContain("user fact");
	});

	it("includes the birth instruction until commissioned", () => {
		const prompt = buildSystemPrompt({ config: loadAgentConfig("scribe") });
		expect(prompt).toContain("newly created and not yet commissioned");
		expect(prompt).toContain("/commission");
		expect(prompt).toContain("self_update");
	});

	it("omits the birth instruction after commissioning", () => {
		const prompt = buildSystemPrompt({ config: commissionAgent("scribe") });
		expect(prompt).not.toContain("newly created and not yet commissioned");
		expect(prompt).not.toContain("/commission");
	});

	it("loads SOUL.md content into the prompt", () => {
		writeMemoryFile(getSoulPath("scribe"), "I am a meeting-memory agent.\n");
		const snapshot = loadMemory("scribe");
		const prompt = buildSystemPrompt({ config: loadAgentConfig("scribe"), ...snapshot });
		expect(prompt).toContain("### SOUL.md");
		expect(prompt).toContain("I am a meeting-memory agent.");
	});
});

describe("frozen-snapshot invariant", () => {
	it("keeps the built prompt stable after a mid-session memory write", async () => {
		const config = loadAgentConfig("scribe");

		// Session start: read memory ONCE and freeze it into the prompt.
		const snapshot = loadMemory("scribe");
		const frozenPrompt = buildSystemPrompt({ config, ...snapshot });

		// Mid-session: the agent writes a new fact via the self_update tool.
		const result = await createSelfUpdateTool("scribe").execute("call-1", {
			file: "MEMORY",
			op: "add",
			content: "a brand new fact",
		});
		expect(result.details.applied).toBe(true);

		// The frozen prompt does NOT change (still byte-identical, no new fact).
		expect(frozenPrompt).not.toContain("a brand new fact");

		// But the next session's load reflects the durable write.
		const nextSession = loadMemory("scribe");
		expect(nextSession.memory).toContain("a brand new fact");
		const nextPrompt = buildSystemPrompt({ config, ...nextSession });
		expect(nextPrompt).toContain("a brand new fact");
	});
});
