/**
 * Transitional CLI entry (Slice 0 scaffold).
 *
 * For now this delegates to the engine's in-process `main` so the `steward` bin keeps working
 * unchanged while the daemon-client surface is built out. Slice 1+ replaces this file with the
 * real client dispatch: `new`/`list`/`delete` over direct engine imports, the hidden
 * `daemon <name>` subcommand onto `runDaemonEntry`, and the default path attaching a daemon
 * (`DaemonSession.open`) to drive `InteractiveMode` / `runPrint` — no in-process fallback.
 */

export { main } from "@opsyhq/steward";
