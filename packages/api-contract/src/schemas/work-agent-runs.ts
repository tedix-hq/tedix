/**
 * The agent runs tedis started from a chat, with each run's real state: what
 * a tedi reads to supervise the runs it started.
 */

import * as z from "zod";
import { WorkAttemptStepKindSchema } from "./work-attempt-steps";
import { WorkAttemptOutcomeSchema } from "./work-items";

export const AgentRunStateSchema = z.enum([
	"waiting_for_runner",
	"running",
	"ended",
]);
export type AgentRunState = z.infer<typeof AgentRunStateSchema>;

export const AgentRunReasonCodeSchema = z.enum([
	"not_accepted",
	"not_ready",
	"not_before",
	"held",
	"start_refused",
	"no_runner",
	"runner_waiting",
	"queued",
	"lease_lost",
	"stopped",
]);
export type AgentRunReasonCode = z.infer<typeof AgentRunReasonCodeSchema>;

export const AgentRunReasonSchema = z.object({
	code: AgentRunReasonCodeSchema.describe(
		"not_accepted, not_ready, not_before: the task itself may not start yet. held: a runner or the platform put the task on hold. start_refused: a runner tried to start the task and the platform refused, with its stored code and reason. no_runner: no connected machine reports a runner for this agent. runner_waiting: a runner has the task and waits before it works on it. queued: nothing blocks the task; a runner has not taken it yet. lease_lost: the run stopped reporting before it was settled. stopped: someone stopped the run.",
	),
	detail: z.string().max(700),
});
export type AgentRunReason = z.infer<typeof AgentRunReasonSchema>;

export const AgentRunSchema = z.object({
	workItemId: z.uuid(),
	title: z.string(),
	executor: z.string().describe("The agent the task is assigned to."),
	tediId: z.string().describe("The tedi that started the run."),
	projectId: z.uuid().nullable(),
	state: AgentRunStateSchema,
	outcome: WorkAttemptOutcomeSchema.nullable().describe(
		"How the newest run ended; null while it has not.",
	),
	createdAt: z.iso.datetime(),
	attemptId: z
		.uuid()
		.nullable()
		.describe("The newest run; null while no runner has picked the task up."),
	attempts: z.number().int().nonnegative(),
	startedAt: z.iso.datetime().nullable(),
	endedAt: z.iso.datetime().nullable(),
	summary: z
		.string()
		.max(500)
		.nullable()
		.describe("The settlement note of the newest run, shortened."),
	lastStep: z
		.object({
			seq: z.number().int().nonnegative(),
			at: z.iso.datetime(),
			kind: WorkAttemptStepKindSchema,
			text: z.string().max(500),
		})
		.nullable(),
	minutesSinceLastStep: z
		.number()
		.int()
		.nonnegative()
		.nullable()
		.describe(
			"Whole minutes since the newest step; for a run with no step yet, since it started. Null when no run has started.",
		),
	pendingFollowUps: z
		.number()
		.int()
		.nonnegative()
		.describe("Follow-ups sent to the newest run that it has not applied."),
	reason: AgentRunReasonSchema.nullable().describe(
		"Why the run is not running, as far as the platform knows. Null while it runs or when it ended on its own.",
	),
	unknown: z
		.string()
		.max(300)
		.nullable()
		.describe(
			"What the platform cannot see about this run, when that limits the reason.",
		),
});
export type AgentRun = z.infer<typeof AgentRunSchema>;

export const ListAgentRunsInputSchema = z.strictObject({
	state: z
		.enum(["live", "ended", "all"])
		.optional()
		.default("live")
		.describe("live: waiting for a runner or running."),
	limit: z.coerce.number().int().min(1).max(50).optional().default(20),
	tediId: z
		.string()
		.min(1)
		.max(128)
		.optional()
		.describe(
			"Only the runs this tedi started. A tedi always reads its own runs, whatever is passed here.",
		),
});

export const ListAgentRunsResultSchema = z.object({
	listedAt: z.iso.datetime(),
	windowDays: z
		.number()
		.int()
		.positive()
		.describe("Runs started longer ago than this are not listed."),
	runs: z.array(AgentRunSchema),
});
export type ListAgentRunsResult = z.infer<typeof ListAgentRunsResultSchema>;
