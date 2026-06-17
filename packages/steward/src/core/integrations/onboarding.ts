/**
 * Integration onboarding — the persist/validate/pair logic, decoupled from the TUI.
 *
 * `onboardIntegration` drives one integration's `onboard(ctx)`, persists the returned
 * record, validates it by reusing the runner's `resolveAccount` path, and copies the
 * paired extension (the mapping half) into `<agentDir>/extensions/`. It is UI-agnostic
 * (the `ui` it forwards is whatever the caller built), so it is unit-testable with a
 * stub UI surface + an in-memory account store. The TUI wiring lives in
 * `cli/integration-onboarding.ts`.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { IntegrationAccountRecord, IntegrationAccountStorage } from "../integration-account-storage.ts";
import { resolveConfigValueUncached } from "../resolve-config-value.ts";
import type { Integration, IntegrationOnboardUI } from "./types.ts";

export interface OnboardIntegrationParams {
	/** Service id to configure. */
	service: string;
	/** Loaded integrations to search for the service definition. */
	integrations: Integration[];
	/** Per-agent account store (the record is written here). */
	accounts: IntegrationAccountStorage;
	/** Narrowed dialog surface forwarded to `onboard(ctx)`. */
	ui: IntegrationOnboardUI;
	/** Per-agent home dir — paired extensions are copied into `<agentDir>/extensions/`. */
	agentDir: string;
	signal?: AbortSignal;
}

export type OnboardIntegrationResult =
	| { status: "connected" }
	| { status: "cancelled" }
	| { status: "not-found" }
	| { status: "no-onboard" }
	| { status: "error"; message: string };

/**
 * Run one integration's guided onboarding end to end. Returns a status (the caller
 * surfaces it to the user); only `onboard`-internal messages (e.g. a token check
 * failing) go through `ctx.ui` here.
 */
export async function onboardIntegration(params: OnboardIntegrationParams): Promise<OnboardIntegrationResult> {
	const { service, integrations, accounts, ui, agentDir, signal } = params;

	const integration = integrations.find((i) => i.definitions.has(service));
	const config = integration?.definitions.get(service);
	if (!integration || !config) {
		return { status: "not-found" };
	}
	if (!config.onboard) {
		return { status: "no-onboard" };
	}

	let record: IntegrationAccountRecord | undefined;
	try {
		record = await config.onboard({
			ui,
			resolve: resolveConfigValueUncached,
			signal: signal ?? new AbortController().signal,
		});
	} catch (err) {
		return { status: "error", message: err instanceof Error ? err.message : String(err) };
	}
	if (!record) {
		return { status: "cancelled" };
	}

	// Validate by reusing the runner's path: set, then resolveAccount (resolves `$ENV`
	// and schema-checks). On failure, roll back the stored record.
	accounts.set(service, "default", record);
	try {
		accounts.resolveAccount(service, "default", config.account);
	} catch (err) {
		accounts.remove(service, "default");
		return { status: "error", message: err instanceof Error ? err.message : String(err) };
	}

	// Copy the paired extension (the mapping half) so it activates next launch.
	copyPairedExtension(integration.resolvedPath, agentDir);
	return { status: "connected" };
}

/**
 * Copy an integration package's paired extension(s) — the mapping half — into
 * `<agentDir>/extensions/` so they activate next launch. Walks up from the integration
 * file to the nearest package.json, reads `steward.extensions`, and copies each entry's
 * basename if not already present (no overwrite).
 */
export function copyPairedExtension(resolvedPath: string, agentDir: string): void {
	let dir = dirname(resolvedPath);
	let pkgPath: string | undefined;
	for (let i = 0; i < 6; i++) {
		const candidate = join(dir, "package.json");
		if (existsSync(candidate)) {
			pkgPath = candidate;
			break;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	if (!pkgPath) return;

	let extensions: string[] | undefined;
	try {
		const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { steward?: { extensions?: string[] } };
		extensions = pkg.steward?.extensions;
	} catch {
		return;
	}
	if (!extensions?.length) return;

	const pkgDir = dirname(pkgPath);
	const extDir = join(agentDir, "extensions");
	if (!existsSync(extDir)) {
		mkdirSync(extDir, { recursive: true });
	}
	for (const entry of extensions) {
		const src = join(pkgDir, entry);
		if (!existsSync(src)) continue;
		const dest = join(extDir, basename(entry));
		if (existsSync(dest)) continue; // never overwrite an existing extension
		copyFileSync(src, dest);
	}
}
