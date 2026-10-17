import * as z from "zod";
import { WorkAgentSessionHarnessSchema } from "./work-agent-sessions";

/**
 * What a ledger row records: from the person's message a request, question or
 * decision; from the agent's turn an ask for the user, a promise or an open
 * loop (a lane it started that has not reported back).
 */
export const AgentSessionRequestKindSchema = z.enum([
	"request",
	"question",
	"decision",
	"ask",
	"promise",
	"open_loop",
]);

/**
 * Where a row stands. `done` always carries evidence; `dropped_risk` means
 * the agent moved on without it; `cancelled` means the person withdrew it.
 */
export const AgentSessionRequestStatusSchema = z.enum([
	"open",
	"in_progress",
	"waiting_on_user",
	"dropped_risk",
	"done",
	"cancelled",
]);

const SessionKeySchema = z
	.string()
	.regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/)
	.describe("The host's own session id, such as Claude Code session_id.");

export const AgentSessionRequestSchema = z.strictObject({
	id: z.uuid(),
	harness: WorkAgentSessionHarnessSchema,
	sessionKey: z.string(),
	repository: z.string().nullable(),
	kind: AgentSessionRequestKindSchema,
	text: z.string().describe("The request in plain words."),
	status: AgentSessionRequestStatusSchema,
	evidence: z
		.string()
		.nullable()
		.describe("Commit SHA, link or quote behind the latest status."),
	sourceAt: z.iso.datetime().describe("When the person sent the message."),
	statusChangedAt: z.iso.datetime(),
});

export const AgentSessionEventSchema = z.strictObject({
	kind: z
		.enum(["prompt", "turn"])
		.describe(
			"`prompt`: a message the person typed; `turn`: an agent turn end.",
		),
	harness: WorkAgentSessionHarnessSchema,
	sessionKey: SessionKeySchema,
	sourceAt: z.iso.datetime().describe("When it happened in the session."),
	text: z
		.string()
		.trim()
		.min(1)
		.describe(
			"The redacted message or full agent turn text, including earlier replies in the turn.",
		),
	activity: z
		.string()
		.trim()
		.max(4000)
		.optional()
		.describe(
			"For a turn: redacted digest of its tool failures, the subagents or other agents it started, and their reports.",
		),
	repository: z
		.string()
		.trim()
		.max(200)
		.optional()
		.describe("Repository name or working folder label."),
});

export const RecordAgentSessionEventsInputSchema = z.strictObject({
	events: z.array(AgentSessionEventSchema).min(1).max(20),
});

export const RecordAgentSessionEventsResultSchema = z.strictObject({
	accepted: z.number().int().nonnegative(),
	duplicates: z
		.number()
		.int()
		.nonnegative()
		.describe("Events already uploaded; stored once."),
});

export const ListAgentSessionRequestsInputSchema = z.strictObject({
	statuses: z.array(AgentSessionRequestStatusSchema).max(6).optional(),
	harness: WorkAgentSessionHarnessSchema.optional(),
	sessionKey: SessionKeySchema.optional(),
	limit: z.number().int().min(1).max(200).default(100),
	order: z
		.enum(["oldest", "newest"])
		.default("oldest")
		.describe(
			"`newest`: newest message first, so a small limit keeps the latest rows.",
		),
});

export const ListAgentSessionRequestsResultSchema = z.strictObject({
	data: z.array(AgentSessionRequestSchema),
});

export const UpdateAgentSessionRequestInputSchema = z.strictObject({
	id: z.uuid(),
	status: AgentSessionRequestStatusSchema,
	evidence: z
		.string()
		.trim()
		.max(300)
		.optional()
		.describe("Why: a commit SHA, link or note. Required for `done`."),
});

export const UpdateAgentSessionRequestResultSchema = z.strictObject({
	request: AgentSessionRequestSchema,
});
