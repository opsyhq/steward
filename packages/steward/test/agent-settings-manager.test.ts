import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAgentConfigPath, getAgentDir, getSoulPath } from "../src/config.ts";
import {
	AGENT_SCHEMA_VERSION,
	AgentSettingsManager,
	isDeployed,
	isValidAgentName,
} from "../src/core/agent-settings-manager.ts";

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "steward-test-"));
	process.env.STEWARD_HOME = home;
	// Isolate shared defaults so the merge can't read the real user's settings.json.
	process.env.STEWARD_SHARED_DIR = join(home, "shared");
});

afterEach(() => {
	delete process.env.STEWARD_HOME;
	delete process.env.STEWARD_SHARED_DIR;
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

describe("AgentSettingsManager round-trip", () => {
	it("creates and loads an agent at the current schema version", () => {
		const created = AgentSettingsManager.create({ name: "scribe", purpose: "take meeting notes" }).config;
		expect(created.name).toBe("scribe");
		expect(created.schemaVersion).toBe(AGENT_SCHEMA_VERSION);
		expect(created.purpose).toBe("take meeting notes");
		expect(AgentSettingsManager.exists("scribe")).toBe(true);

		const loaded = AgentSettingsManager.load("scribe").config;
		expect(loaded).toEqual(created);
	});

	it("defaults purpose to an empty string when omitted (the agent distills it in-chat)", () => {
		const created = AgentSettingsManager.create({ name: "scribe" }).config;
		expect(created.purpose).toBe("");
		expect(AgentSettingsManager.load("scribe").config.purpose).toBe("");
	});

	it("folds an optional model into settings.defaultModel", () => {
		AgentSettingsManager.create({ name: "scribe", purpose: "x", model: "anthropic/claude-opus-4-8" });
		const store = AgentSettingsManager.load("scribe");
		expect(store.config.settings?.defaultModel).toBe("anthropic/claude-opus-4-8");
		// No flat `model` field on the persisted config.
		expect((store.config as Record<string, unknown>).model).toBeUndefined();
		// getDefaultModel returns the agent override as a combined reference.
		expect(store.getDefaultModel()).toBe("anthropic/claude-opus-4-8");
	});

	it("rejects duplicate creation", () => {
		AgentSettingsManager.create({ name: "scribe", purpose: "take notes" });
		expect(() => AgentSettingsManager.create({ name: "scribe", purpose: "again" })).toThrow(/already exists/);
	});

	it("rejects invalid names", () => {
		expect(() => AgentSettingsManager.create({ name: "Bad Name", purpose: "x" })).toThrow(/Invalid agent name/);
	});

	it("lists agents sorted by name", () => {
		AgentSettingsManager.create({ name: "zeta", purpose: "z" });
		AgentSettingsManager.create({ name: "alpha", purpose: "a" });
		expect(AgentSettingsManager.list().map((store) => store.name)).toEqual(["alpha", "zeta"]);
	});

	it("returns an empty list when no agents exist", () => {
		expect(AgentSettingsManager.list()).toEqual([]);
	});
});

describe("deploy", () => {
	it("creates an agent undeployed with a SOUL.md", () => {
		const created = AgentSettingsManager.create({ name: "calories", purpose: "track meals" }).config;
		expect(created.deployedAt).toBeNull();
		expect(isDeployed(created)).toBe(false);
		expect(existsSync(getSoulPath("calories"))).toBe(true);
	});

	it("deploy stamps an ISO timestamp", () => {
		AgentSettingsManager.create({ name: "calories", purpose: "track meals" });
		const updated = AgentSettingsManager.load("calories").deploy();
		expect(updated.deployedAt).toBeTruthy();
		expect(new Date(updated.deployedAt as string).toISOString()).toBe(updated.deployedAt);
		expect(isDeployed(updated)).toBe(true);
		expect(AgentSettingsManager.load("calories").isDeployed()).toBe(true);
	});

	it("is idempotent — a second call leaves the timestamp unchanged", () => {
		AgentSettingsManager.create({ name: "calories", purpose: "track meals" });
		const first = AgentSettingsManager.load("calories").deploy();
		const second = AgentSettingsManager.load("calories").deploy();
		expect(second.deployedAt).toBe(first.deployedAt);
	});
});

describe("setPurpose", () => {
	it("overwrites and persists the purpose", () => {
		AgentSettingsManager.create({ name: "scribe" });
		const updated = AgentSettingsManager.load("scribe").setPurpose("keep the meeting minutes");
		expect(updated.purpose).toBe("keep the meeting minutes");
		expect(AgentSettingsManager.load("scribe").config.purpose).toBe("keep the meeting minutes");
	});
});

describe("delete", () => {
	it("removes the agent's home dir", () => {
		AgentSettingsManager.create({ name: "scratch", purpose: "temp" });
		expect(existsSync(getAgentDir("scratch"))).toBe(true);

		const result = AgentSettingsManager.delete("scratch");
		expect(result.ok).toBe(true);
		expect(existsSync(getAgentDir("scratch"))).toBe(false);
		expect(AgentSettingsManager.exists("scratch")).toBe(false);
	});
});

describe("legacy configs", () => {
	it("loads a pre-deployedAt config (treated as not deployed)", () => {
		AgentSettingsManager.create({ name: "old" });
		const legacy = { schemaVersion: 1, name: "old", purpose: "old agent", createdAt: new Date().toISOString() };
		writeFileSync(getAgentConfigPath("old"), `${JSON.stringify(legacy, null, 2)}\n`, "utf-8");
		const store = AgentSettingsManager.load("old");
		expect(store.config.deployedAt).toBeUndefined();
		expect(store.isDeployed()).toBe(false);
	});
});
