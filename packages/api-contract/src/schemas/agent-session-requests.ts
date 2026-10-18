import * as z from "zod";
import { WorkAgentSessionHarnessSchema } from "./work-agent-sessions";
import { KernelAcceptanceCheckSchema } from "./kernel-request";

/**
 * What a ledger row records: from the person's message a request, question or
 * decision; from the agent's turn an ask for the user, a promise or an open
 * loop (a lane it started that has not reported back).
 */
export const AgentSessionRequestKindSchema = z.enum([
	"request",
	"question",
	"decision",
	"idea",
	"issue",
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
	projectId: z.uuid().nullable().optional(),
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
	rebuildFailedSession: z
		.strictObject({
			harness: WorkAgentSessionHarnessSchema,
			sessionKey: SessionKeySchema,
			expectedEvents: z.number().int().min(1),
			expectedRequests: z.number().int().nonnegative(),
		})
		.optional()
		.describe(
			"Explicitly discard this caller-owned failed session’s derived request rows and replay all its immutable events. Requires exact current counts, a failed event, and no processing leases. Other sessions are untouched. Export rows before rebuilding.",
		),
	retryFailed: z
		.boolean()
		.optional()
		.describe(
			"Explicitly restart failed copies of these exact events with a fresh retry budget, only when no later event in that session was processed or leased. Pending and processed events are unchanged.",
		),
});

export const RecordAgentSessionEventsResultSchema = z.strictObject({
	accepted: z.number().int().nonnegative(),
	rebuilt: z.number().int().nonnegative().optional(),
	duplicates: z
		.number()
		.int()
		.nonnegative()
		.describe("Events already uploaded; stored once."),
	retried: z
		.number()
		.int()
		.nonnegative()
		.optional()
		.describe("Failed events restarted by an explicit retryFailed request."),
});

export const ListAgentSessionRequestsInputSchema = z.strictObject({
	statuses: z.array(AgentSessionRequestStatusSchema).max(6).optional(),
	changedSince: z.iso
		.datetime()
		.optional()
		.describe(
			"Keep rows whose status changed at or after this instant, including requests originally made earlier.",
		),
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

export const FileAgentSessionRequestInputSchema = z.strictObject({
	id: z.uuid(),
	projectId: z.uuid().nullable(),
	expectedProjectId: z.uuid().nullable().optional(),
	workItemId: z.uuid().optional(),
	acceptanceChecks: z.array(KernelAcceptanceCheckSchema).max(20).optional(),
});

/** Internal personal resource: no OAuth connection or credential is involved. */
export const SESSION_ACTIVITY_RESOURCE = {
	providerId: "tedix-session-activity",
	resourceType: "session_activity",
	toolId: "list_agent_session_activity",
} as const;
export const ListAgentSessionActivityInputSchema = z.strictObject({
	since: z.iso.datetime(),
	limit: z.number().int().min(1).max(100).default(50),
	requests: ListAgentSessionRequestsInputSchema.optional().describe(
		"Also read the consenting owner's derived request ledger with these filters. Never accepts an owner identity.",
	),
});
export const ListAgentSessionActivityResultSchema = z.strictObject({
	status: z.enum(["ready", "needs_grant"]),
	summary: z.string(),
	requests: z.array(AgentSessionRequestSchema).optional(),
	data: z.array(
		z.strictObject({
			id: z.string(),
			harness: WorkAgentSessionHarnessSchema,
			sessionKey: z.string(),
			repository: z.string().nullable(),
			kind: z.enum(["prompt", "turn"]),
			sourceAt: z.string(),
			text: z.string(),
			activity: z.string().nullable(),
		}),
	),
});

export const ClassifyAgentSessionRequestsInputSchema = z.strictObject({
	runNow: z
		.boolean()
		.optional()
		.describe(
			"Run one filing synchronously and report its outcome; queue remaining rows. Model or storage failures are returned to the caller.",
		),
	enabled: z
		.boolean()
		.optional()
		.describe(
			"Enable or disable automatic filing for your private ledger. Enabling allows organization-visible container briefs, proposed Work and corrected filing examples; uploaded source events remain private.",
		),
});
export const ClassifyAgentSessionRequestsResultSchema = z.strictObject({
	queued: z.boolean(),
	pass: z
		.strictObject({
			state: z.enum([
				"processed",
				"inactive_owner",
				"paused",
				"permission_denied",
			]),
			pending: z.number().int().nonnegative().optional(),
		})
		.optional(),
});
