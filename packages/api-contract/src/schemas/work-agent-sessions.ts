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

/** State shown on the board; `idle` is derived from age when the board is read. */
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
		.describe("Short human label, such as the repository folder and branch."),
});

export const WorkAgentSessionStatusSchema = z.strictObject({
	id: z.uuid(),
	harness: WorkAgentSessionHarnessSchema,
	sessionKey: z.string(),
	label: z.string(),
	state: WorkAgentSessionStateSchema,
	effectiveState: WorkAgentSessionEffectiveStateSchema,
	summary: z.string(),
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
