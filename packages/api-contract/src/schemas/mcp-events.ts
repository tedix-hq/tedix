import * as z from "zod";

/**
 * Ledger-backed feeds behind the MCP Events (SEP-3415) `events/poll` surface.
 * Every row is a notification hint: it carries identifiers and enums only,
 * never request bodies, summaries or error text, and grants no authority.
 */

const PollLimitSchema = z.number().int().min(1).max(100).default(50);

/** Keyset position over (timestamp, id); empty strings sort before any row. */
export const McpEventKeysetCursorSchema = z.object({
	at: z.string().max(64),
	id: z.string().max(128),
});

const OptionalIdSchema = z.string().min(1).max(128).optional();

export const WorkStateChangeSchema = z.enum([
	"accepted",
	"completed",
	"cancelled",
	"attempt_settled",
]);

export const WorkStateChangedEventSchema = z.object({
	eventId: z.string(),
	timestamp: z.string(),
	data: z.object({
		organization_id: z.string(),
		work_item_id: z.string(),
		change: WorkStateChangeSchema,
		disposition: z.enum(["accepted", "completed", "cancelled"]).nullable(),
		attempt_id: z.string().nullable(),
		attempt_outcome: z.string().nullable(),
	}),
});

export const PollWorkStateChangesInputSchema = z.object({
	/** Omit (or null) to start from the ledger head without replay. */
	afterSequence: z.number().int().min(0).nullable().optional(),
	workItemId: OptionalIdSchema,
	limit: PollLimitSchema,
});

export const PollWorkStateChangesResultSchema = z.object({
	events: z.array(WorkStateChangedEventSchema),
	afterSequence: z.number().int().min(0),
	hasMore: z.boolean(),
});

export const WorkApprovalRequestedEventSchema = z.object({
	eventId: z.string(),
	timestamp: z.string(),
	data: z.object({
		organization_id: z.string(),
		work_item_id: z.string(),
		approval_id: z.string(),
		action: z.string(),
		authority_key: z.string(),
		approver_type: z.enum(["user", "tedi"]),
		approver_id: z.string(),
		expires_at: z.string(),
	}),
});

export const PollWorkApprovalRequestsInputSchema = z.object({
	/** Omit (or null) to start from the newest request without replay. */
	after: McpEventKeysetCursorSchema.nullable().optional(),
	workItemId: OptionalIdSchema,
	approverId: OptionalIdSchema,
	limit: PollLimitSchema,
});

export const PollWorkApprovalRequestsResultSchema = z.object({
	events: z.array(WorkApprovalRequestedEventSchema),
	after: McpEventKeysetCursorSchema,
	hasMore: z.boolean(),
});

export const SkillRunFailedEventSchema = z.object({
	eventId: z.string(),
	timestamp: z.string(),
	data: z.object({
		organization_id: z.string(),
		run_id: z.string(),
		skill_id: z.string(),
		tedi_id: z.string(),
		work_item_id: z.string().nullable(),
		error_class: z.enum(["admission", "execution"]),
	}),
});

export const PollFailedSkillRunsInputSchema = z.object({
	/** Omit (or null) to start from the newest failure without replay. */
	after: McpEventKeysetCursorSchema.nullable().optional(),
	tediId: OptionalIdSchema,
	skillId: OptionalIdSchema,
	limit: PollLimitSchema,
});

export const PollFailedSkillRunsResultSchema = z.object({
	events: z.array(SkillRunFailedEventSchema),
	after: McpEventKeysetCursorSchema,
	hasMore: z.boolean(),
});
