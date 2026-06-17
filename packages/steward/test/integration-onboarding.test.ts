/**
 * Onboarding logic for integrations — the UI-agnostic core (`onboardIntegration` +
 * `copyPairedExtension`) plus the runner's go-live idempotency guard.
 *
 * The TUI wiring (`cli/integration-onboarding.ts`) is intentionally not
 * exercised — these tests cover persistence, validation rollback, cancellation, the
 * paired-extension copy, and `start()` attaching a producer exactly once, all with an
 * in-memory account store and a stub `ExtensionUIContext`.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { IntegrationAccountRecord } from "../src/core/integration-account-storage.ts";
import { IntegrationAccountStorage } from "../src/core/integration-account-storage.ts";
import {
	createIntegrationRuntime,
	IntegrationRunner,
	type IntegrationsAPI,
	loadIntegrationFromFactory,
} from "../src/core/integrations/index.ts";
import { copyPairedExtension, onboardIntegration } from "../src/core/integrations/onboarding.ts";
import type { IntegrationOnboardContext, IntegrationOnboardUI } from "../src/core/integrations/types.ts";

// The onboards under test never call the UI; this is a fully-typed no-op surface
// (no casts) so a stray UI call would be a typed no-op, not a runtime surprise.
const ui: IntegrationOnboardUI = {
	select: async () => undefined,
	confirm: async () => false,
	input: async () => undefined,
	notify: () => {},
	custom: () => Promise.reject(new Error("custom() is not exercised by these tests")),
};

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}
afterEach(() => {
	while (tmpDirs.length) {
		rmSync(tmpDirs.pop()!, { recursive: true, force: true });
	}
});

type OnboardFn = (ctx: IntegrationOnboardContext) => Promise<IntegrationAccountRecord | undefined>;

async function makeIntegration(onboard: OnboardFn | undefined) {
	const runtime = createIntegrationRuntime();
	const factory = (steward: IntegrationsAPI) => {
		steward.registerIntegration({
			name: "fakesvc",
			account: Type.Object({ token: Type.String() }),
			onboard,
		});
	};
	// resolvedPath lives in an isolated temp dir (no ancestor package.json declares
	// `steward.extensions`), so copyPairedExtension is a deterministic no-op here.
	return loadIntegrationFromFactory(factory, process.cwd(), runtime, join(tmp("steward-onboard-int-"), "index.ts"));
}

describe("onboardIntegration", () => {
	it("persists the $ENV reference on success", async () => {
		process.env.FAKE_ONBOARD_TOKEN = "secret-value";
		const integration = await makeIntegration(async () => ({ token: "$FAKE_ONBOARD_TOKEN" }));
		const accounts = IntegrationAccountStorage.inMemory({});

		expect(accounts.has("fakesvc", "default")).toBe(false);
		const result = await onboardIntegration({
			service: "fakesvc",
			integrations: [integration],
			accounts,
			ui,
			agentDir: tmp("steward-onboard-agent-"),
		});

		expect(result.status).toBe("connected");
		expect(accounts.has("fakesvc", "default")).toBe(true);
		// The stored record is the $ENV reference, never the raw secret.
		expect(accounts.get("fakesvc", "default")).toEqual({ token: "$FAKE_ONBOARD_TOKEN" });
		delete process.env.FAKE_ONBOARD_TOKEN;
	});

	it("rolls back a record that fails validation", async () => {
		// token: 123 is not a string → resolveAccount's schema check throws → removed.
		const integration = await makeIntegration(async () => ({ token: 123 }));
		const accounts = IntegrationAccountStorage.inMemory({});

		const result = await onboardIntegration({
			service: "fakesvc",
			integrations: [integration],
			accounts,
			ui,
			agentDir: tmp("steward-onboard-agent-"),
		});

		expect(result.status).toBe("error");
		expect(accounts.has("fakesvc", "default")).toBe(false);
	});

	it("returns cancelled (and stores nothing) when onboard yields undefined", async () => {
		const integration = await makeIntegration(async () => undefined);
		const accounts = IntegrationAccountStorage.inMemory({});

		const result = await onboardIntegration({
			service: "fakesvc",
			integrations: [integration],
			accounts,
			ui,
			agentDir: tmp("steward-onboard-agent-"),
		});

		expect(result.status).toBe("cancelled");
		expect(accounts.has("fakesvc", "default")).toBe(false);
	});

	it("reports not-found / no-onboard cleanly", async () => {
		const accounts = IntegrationAccountStorage.inMemory({});
		const withOnboard = await makeIntegration(async () => ({ token: "x" }));

		const notFound = await onboardIntegration({
			service: "missing",
			integrations: [withOnboard],
			accounts,
			ui,
			agentDir: tmp("steward-onboard-agent-"),
		});
		expect(notFound.status).toBe("not-found");

		const noOnboard = await makeIntegration(undefined);
		const result = await onboardIntegration({
			service: "fakesvc",
			integrations: [noOnboard],
			accounts,
			ui,
			agentDir: tmp("steward-onboard-agent-"),
		});
		expect(result.status).toBe("no-onboard");
	});
});

describe("copyPairedExtension", () => {
	it("copies the package's steward.extensions and never overwrites", () => {
		const pkgDir = tmp("steward-onboard-pkg-");
		writeFileSync(
			join(pkgDir, "package.json"),
			JSON.stringify({ name: "x", steward: { integrations: ["./index.ts"], extensions: ["./telegram-chat.ts"] } }),
		);
		writeFileSync(join(pkgDir, "index.ts"), "// integration");
		writeFileSync(join(pkgDir, "telegram-chat.ts"), "// original ext");
		const agentDir = tmp("steward-onboard-agent-");

		copyPairedExtension(join(pkgDir, "index.ts"), agentDir);
		const dest = join(agentDir, "extensions", "telegram-chat.ts");
		expect(existsSync(dest)).toBe(true);
		expect(readFileSync(dest, "utf-8")).toBe("// original ext");

		// Idempotent: a second copy must not clobber an existing (possibly user-edited) file.
		writeFileSync(dest, "// user-edited");
		copyPairedExtension(join(pkgDir, "index.ts"), agentDir);
		expect(readFileSync(dest, "utf-8")).toBe("// user-edited");
	});
});

describe("IntegrationRunner.start idempotency (go-live)", () => {
	it("attaches a configured producer exactly once across repeated start()", async () => {
		let runs = 0;
		const runtime = createIntegrationRuntime();
		const factory = (steward: IntegrationsAPI) => {
			steward.registerIntegration({
				name: "fakesvc",
				account: Type.Object({ token: Type.String() }),
				events: { ping: Type.Object({}) },
				run() {
					runs++;
					return () => {};
				},
			});
		};
		const integration = await loadIntegrationFromFactory(factory, process.cwd(), runtime, "<fake>");
		const accounts = IntegrationAccountStorage.inMemory({ fakesvc: { default: { token: "literal" } } });
		const runner = new IntegrationRunner([integration], runtime, process.cwd(), accounts);
		runner.bindCore();

		await runner.start();
		await runner.start();
		expect(runs).toBe(1);

		await runner.stop();
	});
});
