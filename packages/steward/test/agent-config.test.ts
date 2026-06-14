import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAgentConfigPath, getSoulPath } from "../src/config.ts";
import {
	agentExists,
	commissionAgent,
	createAgent,
	isCommissioned,
	isValidAgentName,
	listAgents,
	loadAgentConfig,
} from "../src/core/agent-config.ts";

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "steward-test-"));
	process.env.STEWARD_HOME = home;
});

afterEach(() => {
	delete process.env.STEWARD_HOME;
	rmSync(home, { recursive: true, force: true });
});

describe("isValidAgentName", () => {
	it("accepts kebab/alphanumeric names", () => {
		expect(isValidAgentName("scribe")).toBe(true);
		expect(isValidAgentName("calorie-bot")).toBe(true);
		expect(isValidAgentName("a1")).toBe(true);
	});

	it("rejects spaces, leading hyphens, uppercase, and empties", () => {
		expect(isValidAgentName("Bad Name")).toBe(false);
		expect(isValidAgentName("-leading")).toBe(false);
		expect(isValidAgentName("Scribe")).toBe(false);
		expect(isValidAgentName("")).toBe(false);
	});
});

describe("agent-config round-trip", () => {
	it("creates and loads an agent", () => {
		const created = createAgent({ name: "scribe", purpose: "take meeting notes" });
		expect(created.name).toBe("scribe");
		expect(created.schemaVersion).toBe(1);
		expect(created.purpose).toBe("take meeting notes");
		expect(created.commissionedAt).toBeNull();
		expect(agentExists("scribe")).toBe(true);
		expect(existsSync(getSoulPath("scribe"))).toBe(true);

		const loaded = loadAgentConfig("scribe");
		expect(loaded).toEqual(created);
	});

	it("persists an optional model", () => {
		createAgent({ name: "scribe", purpose: "x", model: "anthropic/claude-opus-4-8" });
		expect(loadAgentConfig("scribe").model).toBe("anthropic/claude-opus-4-8");
	});

	it("rejects duplicate creation", () => {
		createAgent({ name: "scribe", purpose: "take notes" });
		expect(() => createAgent({ name: "scribe", purpose: "again" })).toThrow(/already exists/);
	});

	it("rejects invalid names", () => {
		expect(() => createAgent({ name: "Bad Name", purpose: "x" })).toThrow(/Invalid agent name/);
	});

	it("lists agents sorted by name", () => {
		createAgent({ name: "zeta", purpose: "z" });
		createAgent({ name: "alpha", purpose: "a" });
		expect(listAgents().map((agent) => agent.name)).toEqual(["alpha", "zeta"]);
	});

	it("returns an empty list when no agents exist", () => {
		expect(listAgents()).toEqual([]);
	});

	it("tracks commissioning state", () => {
		const created = createAgent({ name: "scribe", purpose: "take notes" });
		expect(isCommissioned(created)).toBe(false);

		const commissioned = commissionAgent("scribe");
		expect(isCommissioned(commissioned)).toBe(true);
		expect(commissioned.commissionedAt).toBeTruthy();
		expect(new Date(commissioned.commissionedAt ?? "").toISOString()).toBe(commissioned.commissionedAt);

		const again = commissionAgent("scribe");
		expect(again.commissionedAt).toBe(commissioned.commissionedAt);
	});

	it("loads pre-commissioning configs without commissionedAt", () => {
		createAgent({ name: "scribe", purpose: "take notes" });
		const path = getAgentConfigPath("scribe");
		const config = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
		delete config.commissionedAt;
		writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf-8");

		const loaded = loadAgentConfig("scribe");
		expect(loaded.commissionedAt).toBeUndefined();
		expect(isCommissioned(loaded)).toBe(false);
	});
});
