/**
 * Integration onboarding — the CLI-facing runner.
 *
 * `integrations configure <agent> <service>` and the post-install step of
 * `integrations add` both land here. It builds the narrowed `IntegrationOnboardUI` as a
 * plain object literal (the coding-agent `createProjectTrustContext` pattern) wired to
 * the short-lived startup-TUI helpers, then drives the UI-agnostic `onboardIntegration`
 * core once per service. This is a CLI sub-flow (sibling of `startup-ui.ts`), not a
 * session mode — no agent session is started.
 */

import { join } from "node:path";
import chalk from "chalk";
import { getAgentDir, getAgentIntegrationsDir } from "../config.ts";
import { IntegrationAccountStorage } from "../core/integration-account-storage.ts";
import { discoverAndLoadIntegrations } from "../core/integrations/loader.ts";
import { onboardIntegration } from "../core/integrations/onboarding.ts";
import type { Integration, IntegrationOnboardUI } from "../core/integrations/types.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { showStartupCustom, showStartupInput, showStartupSelector } from "./startup-ui.ts";

/** Build the narrowed onboarding UI over the standalone startup-TUI helpers. */
function createOnboardUi(settingsManager: SettingsManager): IntegrationOnboardUI {
	return {
		select: (title, options) =>
			showStartupSelector(
				settingsManager,
				title,
				options.map((option) => ({ label: option, value: option })),
			),
		confirm: async (title, message) =>
			(await showStartupSelector(settingsManager, `${title}\n${message}`, [
				{ label: "Yes", value: true },
				{ label: "No", value: false },
			])) ?? false,
		input: (title, placeholder) => showStartupInput(settingsManager, title, placeholder),
		custom: (factory, options) => showStartupCustom(settingsManager, factory, options),
		// Each prompt is its own short-lived TUI, so notifications print to the console
		// between prompts.
		notify: (message, type = "info") => {
			if (type === "error") {
				console.error(chalk.red(message));
			} else if (type === "warning") {
				console.error(chalk.yellow(message));
			} else {
				console.log(chalk.cyan(message));
			}
		},
	};
}

/** Discover integrations once, select services to onboard, then drive each through onboarding. */
async function runOnboarding(
	agentName: string,
	selectServices: (integrations: Integration[]) => string[],
): Promise<number> {
	const agentDir = getAgentDir(agentName);
	const { integrations, errors } = await discoverAndLoadIntegrations([], agentDir, agentDir);
	for (const e of errors) {
		console.error(chalk.yellow(`Warning: ${e.error}`));
	}
	const services = selectServices(integrations);
	if (services.length === 0) {
		console.log(chalk.dim("No guided setup available for this integration."));
		return 0;
	}

	const accounts = IntegrationAccountStorage.create(agentName);
	const settingsManager = SettingsManager.create(agentDir);
	const ui = createOnboardUi(settingsManager);

	let exit = 0;
	for (const service of services) {
		const result = await onboardIntegration({ service, integrations, accounts, ui, agentDir });
		switch (result.status) {
			case "connected":
				console.log(chalk.green(`${service} connected.`));
				console.log(chalk.dim(`Run "steward ${agentName}" to use it.`));
				break;
			case "cancelled":
				console.log(chalk.dim(`${service}: onboarding cancelled.`));
				break;
			case "not-found":
				console.error(chalk.red(`Integration "${service}" is not installed for "${agentName}".`));
				exit = 1;
				break;
			case "no-onboard":
				console.error(chalk.red(`Integration "${service}" has no guided setup.`));
				exit = 1;
				break;
			case "error":
				console.error(chalk.red(`${service}: ${result.message}`));
				exit = 1;
				break;
		}
	}
	return exit;
}

/** `integrations configure <agent> <service>` — re-run one service's guided setup. */
export function runIntegrationOnboarding(agentName: string, service: string): Promise<number> {
	return runOnboarding(agentName, () => [service]);
}

/**
 * Post-install onboarding for `integrations add`: onboard every service the just-installed
 * package declares that has an `onboard(ctx)`. The package is the integration(s) whose
 * `resolvedPath` lives under the new `<agentDir>/integrations/<linkName>` symlink.
 */
export function runOnboardForInstalledPackage(agentName: string, linkName: string): Promise<number> {
	const prefix = join(getAgentIntegrationsDir(agentName), linkName);
	return runOnboarding(agentName, (integrations) => {
		const services: string[] = [];
		for (const integration of integrations) {
			if (!integration.resolvedPath.startsWith(prefix)) continue;
			for (const [service, config] of integration.definitions) {
				if (config.onboard) services.push(service);
			}
		}
		return services;
	});
}
