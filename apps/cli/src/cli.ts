#!/usr/bin/env node
/**
 * bin shim for the `steward` CLI: set the process title and env, suppress Node process
 * warnings, configure the HTTP dispatcher (matters when this same bin runs as the daemon via
 * the hidden `daemon <name>` subcommand), then hand off to `main`.
 *
 * `main` returns a numeric exit code, so this shim awaits it and sets `process.exitCode`
 * (mapping a thrown error to exit code 1).
 */

import { APP_NAME, configureHttpDispatcher } from "@opsyhq/steward";
import { main } from "./main.ts";

process.title = APP_NAME;
process.env.STEWARD_CODING_AGENT = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;

// Configure undici's global dispatcher before provider SDKs issue requests.
// The default idle timeout is final (no settings-driven re-application).
configureHttpDispatcher();

main(process.argv.slice(2))
	.then((code) => {
		process.exitCode = code;
	})
	.catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
