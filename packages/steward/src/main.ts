/**
 * Engine CLI entry point.
 *
 * `main(argv)` handles only `--help` / `--version` for the `@opsyhq/cli` client, which delegates
 * them here. Every agent surface (`new` / `list` / `delete` / `integrations` / `packages` /
 * interactive / `--print`) lives in `@opsyhq/cli`; the daemon runner is the exported `runDaemon`
 * (in `daemon/server.ts`).
 */

import { parseArgs, printHelp } from "./cli/args.ts";
import { APP_NAME, VERSION } from "./config.ts";

export async function main(argv: string[]): Promise<number> {
	const args = parseArgs(argv);

	if (args.help) {
		printHelp();
		return 0;
	}
	if (args.version) {
		console.log(`${APP_NAME} ${VERSION}`);
		return 0;
	}

	for (const diagnostic of args.diagnostics) {
		process.stderr.write(`${diagnostic.message}\n`);
	}

	const [command] = args.positionals;
	if (!command) {
		printHelp();
		return 1;
	}

	// Agent surfaces (`new`/`list`/`delete`/`integrations`/`packages`/interactive/`--print`) and the
	// `daemon` runner are owned by the `@opsyhq/cli` client; the engine never dispatches them.
	process.stderr.write(`Unknown command "${command}".\n`);
	return 1;
}
