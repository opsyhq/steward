/**
 * Scheduler chat extension — the mapping half (paired with `index.ts`).
 *
 * The integration (`index.ts`) is the producer (jobs, wake timer, `due` events); this
 * extension maps that onto the agent:
 *
 *   - tool:   registers the `cron` tool so the agent schedules its own jobs
 *             (add / list / update / remove / run) via the integration's CRUD actions.
 *   - inbound: `scheduler.on("due")` wakes a session with the job's prompt.
 *
 * Session binding via tags: an "isolated" job (the default) gets its OWN session bound by
 * a `{ "scheduler:job": <id> }` tag, so repeated runs of the same job land in one session
 * and any extension can find it with `steward.findSessions({ "scheduler:job": <id> })`.
 *
 * `target: "current"` (deliver into the session that created the job) is honored only when
 * the job carries a `createdSessionId`; the public `Session` facade exposes no id today, so
 * the `cron` tool can't capture it and a "current" job falls back to an isolated session.
 *
 * This file is declared under the package's `steward.extensions` and is copied into
 * `<agent>/extensions/` when the integration is onboarded.
 */

import type { ExtensionAPI } from "@opsyhq/steward";
import { Type } from "typebox";

const Target = Type.Union([Type.Literal("isolated"), Type.Literal("current")]);

const CronParams = Type.Object({
	action: Type.Union([
		Type.Literal("add"),
		Type.Literal("list"),
		Type.Literal("update"),
		Type.Literal("remove"),
		Type.Literal("run"),
	]),
	prompt: Type.Optional(Type.String({ description: "What to run (the woken session's first message)." })),
	name: Type.Optional(Type.String({ description: "Human label for the job." })),
	at: Type.Optional(Type.Number({ description: "One-shot run time, epoch ms." })),
	everyMs: Type.Optional(Type.Number({ description: "Fixed interval in ms." })),
	cron: Type.Optional(Type.String({ description: "Cron expression (5/6-field)." })),
	tz: Type.Optional(Type.String({ description: "Timezone for the cron expression (host local if omitted)." })),
	target: Type.Optional(Target),
	id: Type.Optional(Type.String({ description: "Job id, for update / remove / run." })),
	enabled: Type.Optional(Type.Boolean({ description: "Enable or disable the job (update)." })),
});

interface Job {
	id: string;
	name?: string;
	prompt: string;
	schedule: { kind: "at"; at: number } | { kind: "every"; everyMs: number } | { kind: "cron"; expr: string; tz?: string };
	enabled: boolean;
	target: "isolated" | "current";
	nextRunAt: number;
	lastRunAt?: number;
}

type CronArgs = {
	action: "add" | "list" | "update" | "remove" | "run";
	prompt?: string;
	name?: string;
	at?: number;
	everyMs?: number;
	cron?: string;
	tz?: string;
	target?: "isolated" | "current";
	id?: string;
	enabled?: boolean;
};

/** Map the tool's flat `at`/`everyMs`/`cron` fields onto the integration's `Schedule` union. */
function buildSchedule(args: CronArgs): Job["schedule"] | undefined {
	if (args.at !== undefined) return { kind: "at", at: args.at };
	if (args.everyMs !== undefined) return { kind: "every", everyMs: args.everyMs };
	if (args.cron !== undefined) return { kind: "cron", expr: args.cron, tz: args.tz };
	return undefined;
}

function describeSchedule(schedule: Job["schedule"]): string {
	switch (schedule.kind) {
		case "at":
			return `at ${new Date(schedule.at).toISOString()}`;
		case "every":
			return `every ${schedule.everyMs}ms`;
		case "cron":
			return `cron "${schedule.expr}"${schedule.tz ? ` (${schedule.tz})` : ""}`;
	}
}

function describeJob(job: Job): string {
	const label = job.name ? `${job.name} ` : "";
	const state = job.enabled ? `next ${new Date(job.nextRunAt).toISOString()}` : "disabled";
	return `${job.id} ${label}— ${describeSchedule(job.schedule)} — ${state}`;
}

function text(message: string, details: unknown) {
	return { content: [{ type: "text" as const, text: message }], details };
}

export default function (steward: ExtensionAPI) {
	const sched = steward.getIntegration("scheduler", "default");

	steward.registerTool({
		name: "cron",
		label: "Cron",
		description:
			"Schedule prompts to run later. Actions: add (prompt + at/everyMs/cron), list, update (id), remove (id), run (id).",
		parameters: CronParams,
		async execute(_toolCallId, params) {
			const args = params as CronArgs;
			try {
				switch (args.action) {
					case "add": {
						if (!args.prompt) return text("Error: prompt is required to add a job.", { error: "prompt required" });
						const schedule = buildSchedule(args);
						if (!schedule) {
							return text("Error: provide one of at, everyMs, or cron.", { error: "schedule required" });
						}
						const result = (await sched.call("addJob", {
							prompt: args.prompt,
							name: args.name,
							schedule,
							target: args.target,
						})) as { id: string; nextRunAt: number };
						return text(
							`Scheduled job ${result.id} — ${describeSchedule(schedule)} — next ${new Date(result.nextRunAt).toISOString()}.`,
							result,
						);
					}
					case "list": {
						const result = (await sched.call("listJobs")) as { jobs: Job[] };
						const body = result.jobs.length
							? result.jobs.map((j) => describeJob(j)).join("\n")
							: "No scheduled jobs.";
						return text(body, result);
					}
					case "update": {
						if (!args.id) return text("Error: id is required to update a job.", { error: "id required" });
						const schedule = buildSchedule(args);
						const result = await sched.call("updateJob", {
							id: args.id,
							prompt: args.prompt,
							name: args.name,
							schedule,
							enabled: args.enabled,
							target: args.target,
						});
						return text(`Updated job ${args.id}.`, result);
					}
					case "remove": {
						if (!args.id) return text("Error: id is required to remove a job.", { error: "id required" });
						const result = (await sched.call("removeJob", { id: args.id })) as { removed: boolean };
						return text(result.removed ? `Removed job ${args.id}.` : `No job ${args.id}.`, result);
					}
					case "run": {
						if (!args.id) return text("Error: id is required to run a job.", { error: "id required" });
						const result = await sched.call("runJob", { id: args.id });
						return text(`Job ${args.id} will run on the next tick.`, result);
					}
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return text(`Error: ${message}`, { error: message });
			}
		},
	});

	// Wake a session when a job comes due.
	sched.on("due", async (data) => {
		const job = data as { id: string; prompt: string; target: "isolated" | "current"; createdSessionId?: string };

		if (job.target === "current" && job.createdSessionId) {
			const session = steward.getSession(job.createdSessionId) ?? (await steward.openSession(job.createdSessionId));
			await session.sendUserMessage(job.prompt, { deliverAs: "followUp" });
			return;
		}

		// Isolated (default): rehydrate this job's tag-bound session, or create + tag a fresh one.
		const tag = { "scheduler:job": job.id };
		const [match] = await steward.findSessions(tag);
		const session = match
			? await steward.openSession(match.id)
			: await steward.createSession({
					setup: async (sessionManager) => {
						await sessionManager.appendTags(tag);
					},
				});
		await session.sendUserMessage(job.prompt, { deliverAs: "followUp" });
	});
}
