import * as z from "zod";

/** Local coding-agent hosts that report turn status through the Tedix plugin. */
export const WorkAgentSessionHarnessSchema = z.enum(["claude-code", "codex"]);

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

export const ReportWorkAgentSessionStatusInputSchema = z.strictObject({
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
