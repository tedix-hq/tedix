import * as z from "zod";

/** Local coding-agent hosts that report turn status through the Tedix plugin. */
export const WorkAgentSessionHarnessSchema = z.enum([
	"claude-code",
	"codex",
	"tedi",
	"skill",
]);

/** State reported by a plugin hook at a turn boundary. */
export const WorkAgentSessionStateSchema = z.enum([
	"needs_you",
	"error",
	"done",
	"working",
	"ended",
]);

/** `idle` is derived from heartbeat age; `ended` requires an explicit report. */
export const WorkAgentSessionEffectiveStateSchema = z.enum([
	"needs_you",
	"error",
	"done",
	"working",
	"idle",
	"ended",
]);

const SummarySchema = z
	.string()
	.trim()
	.max(200)
	.describe("One plain-text line describing the session's latest outcome.");

/** Observed execution facts, separate from Work admission and verification. */
export const LaneTelemetryInputSchema = z
	.strictObject({
		executor: z.enum(["codex", "claude-code", "tedi", "skill"]),
		model: z.string().max(200).nullable(),
		provider: z.string().max(80).nullable(),
		reasoningEffort: z.string().max(40).nullable(),
		brief: z.string().max(24000),
		startedAt: z.iso.datetime(),
		finishedAt: z.iso.datetime().nullable(),
		heartbeatAt: z.iso.datetime(),
		outcome: z.enum(["succeeded", "stopped", "failed"]).nullable(),
		finalMessage: z.string().max(24000),
		tools: z
			.record(z.string().max(200), z.number().int().nonnegative())
			.refine((v) => Object.keys(v).length <= 200),
		usage: z
			.strictObject({
				input: z.number().int().nonnegative(),
				cached: z.number().int().nonnegative(),
				output: z.number().int().nonnegative(),
				reasoning: z.number().int().nonnegative(),
			})
			.nullable(),
		usageSamples: z
			.array(
				z.strictObject({
					model: z.string().max(200),
					input: z.number().int().nonnegative(),
					cached: z.number().int().nonnegative(),
					output: z.number().int().nonnegative(),
					reasoning: z.number().int().nonnegative(),
					cacheWrite: z.number().int().nonnegative().default(0),
				}),
			)
			.max(10000)
			.optional(),
		shas: z.array(z.string().regex(/^[a-f0-9]{40}$/)).max(100),
		workItems: z.array(z.uuid()).max(100),
		corrections: z.array(z.string().max(2000)).max(20),
		source: z.enum(["wrapper", "hook", "import", "runtime"]),
		rateScope: z.string().max(200).optional(),
	})
	.refine((v) => !v.finishedAt || v.finishedAt >= v.startedAt, {
		message: "Finish precedes start",
	})
	.refine(
		(v) =>
			!v.usage ||
			(v.usage.cached <= v.usage.input && v.usage.reasoning <= v.usage.output),
		{ message: "Token subsets exceed totals" },
	);

export const LaneTelemetrySchema = z.object({
	...LaneTelemetryInputSchema.shape,
	// Stored Work briefs can exceed the host-report input limit.
	brief: z.string(),
	estimatedCostUsd: z.number().nonnegative().nullable(),
	rateVersionId: z.string().nullable(),
	rateVersionIds: z.array(z.string()).optional(),
	estimatedAt: z.iso.datetime().optional(),
	lesson: z.string().nullable(),
	lessonStatus: z.enum(["pending", "extracted", "unavailable"]),
});

export const ReportWorkAgentSessionStatusInputSchema = z.strictObject({
	telemetry: LaneTelemetryInputSchema.optional(),
	harness: WorkAgentSessionHarnessSchema,
	sessionKey: z
		.string()
		.regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/)
		.describe("The host's own session id, such as Claude Code session_id."),
	state: WorkAgentSessionStateSchema,
	summary: SummarySchema,
	label: z
		.string()
		.trim()
		.max(120)
		.describe(
			"Short human label: the session's name, else the repository folder and branch.",
		),
	projectId: z
		.uuid()
		.optional()
		.describe(
			"Work project the session's checkout is bound to; ignored unless it belongs to the caller's organization.",
		),
	workItemId: z
		.uuid()
		.optional()
		.describe(
			"Work Item the session has selected; ignored unless it belongs to the caller's organization.",
		),
});

export const WorkAgentSessionStatusSchema = z.strictObject({
	id: z.uuid(),
	telemetry: LaneTelemetrySchema.nullable().optional(),
	harness: WorkAgentSessionHarnessSchema,
	sessionKey: z.string(),
	label: z.string(),
	state: WorkAgentSessionStateSchema,
	effectiveState: WorkAgentSessionEffectiveStateSchema,
	summary: z.string(),
	projectId: z
		.string()
		.nullable()
		.describe("Null when the session is not bound to a Work project."),
	workItemId: z
		.string()
		.nullable()
		.describe("Null when the session has no selected Work Item."),
	stateSince: z.iso.datetime(),
	lastEventAt: z.iso.datetime(),
});

export const ReportWorkAgentSessionStatusResultSchema = z.strictObject({
	session: WorkAgentSessionStatusSchema,
	changed: z
		.boolean()
		.describe("True when the reported state differs from the stored one."),
});

export const ListWorkAgentSessionsInputSchema = z.strictObject({
	includeEnded: z.boolean().optional(),
});

export const ListWorkAgentSessionsResultSchema = z.strictObject({
	sessions: z
		.array(WorkAgentSessionStatusSchema)
		.describe(
			"The caller's own sessions, most urgent first: needs_you, error, done, working, idle, ended.",
		),
	counts: z.record(WorkAgentSessionEffectiveStateSchema, z.number().int()),
});

/** Contributor state: a board state, or `unknown` when only Attempts are known. */
export const WorkProjectContributorStateSchema = z.enum([
	...WorkAgentSessionEffectiveStateSchema.options,
	"unknown",
]);

export const ListWorkProjectContributorsInputSchema = z.strictObject({
	projectId: z.uuid(),
});

export const WorkProjectContributorSchema = z.strictObject({
	sessionKey: z
		.string()
		.describe("`<harness>:<host session id>`, as Work Attempts store it."),
	harness: z.string(),
	name: z
		.string()
		.describe(
			"Session name or folder and branch; the session key when unreported.",
		),
	state: WorkProjectContributorStateSchema,
	summary: z.string(),
	lastActivityAt: z.iso.datetime(),
	workItemId: z
		.string()
		.nullable()
		.describe("Null when no current or recent Work Item is known."),
	workItemTitle: z
		.string()
		.nullable()
		.describe("Null when no current or recent Work Item is known."),
	attempts: z
		.number()
		.int()
		.describe("Attempts this session held on the project's Work Items."),
});

export const ListWorkProjectContributorsResultSchema = z.strictObject({
	contributors: z
		.array(WorkProjectContributorSchema)
		.describe(
			"Every Claude Code and Codex session that reported into the project or held an Attempt on its Work Items, active first, then by last activity.",
		),
});
