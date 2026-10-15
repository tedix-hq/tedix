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

export const WorkItemCommentedEventSchema = z.object({
	eventId: z.string(),
	timestamp: z.string(),
	data: z.object({
		organization_id: z.string(),
		work_item_id: z.string(),
		comment_id: z.string(),
		author_type: z.enum(["user", "tedi", "external_agent", "system"]),
		author_id: z.string().nullable(),
	}),
});
export const PollWorkCommentsInputSchema = z.object({
	/** Omit (or null) to start from the ledger head without replay. */
	after: McpEventKeysetCursorSchema.nullable().optional(),
	workItemId: z.string().uuid().optional(),
	authorType: z.enum(["user", "tedi", "external_agent", "system"]).optional(),
	limit: PollLimitSchema,
});
export const PollWorkCommentsResultSchema = z.object({
	events: z.array(WorkItemCommentedEventSchema),
	after: McpEventKeysetCursorSchema,
	hasMore: z.boolean(),
});

export const WorkInteractionRequestedEventSchema = z.object({
	eventId: z.string(),
	timestamp: z.string(),
	data: z.object({
		organization_id: z.string(),
		request_id: z.string(),
		work_item_id: z.string().nullable(),
		project_id: z.string().nullable(),
		kind: z.enum(["question", "input", "handoff", "coordination"]),
		target_type: z.enum(["user", "tedi", "external_agent"]).nullable(),
		target_id: z.string().nullable(),
		creator_type: z.enum(["user", "tedi", "external_agent", "system"]),
		due_at: z.string().nullable(),
	}),
});
export const PollWorkInteractionRequestsInputSchema = z.object({
	/** Omit (or null) to start from the ledger head without replay. */
	after: McpEventKeysetCursorSchema.nullable().optional(),
	workItemId: z.string().uuid().optional(),
	targetId: OptionalIdSchema,
	kind: z.enum(["question", "input", "handoff", "coordination"]).optional(),
	limit: PollLimitSchema,
});
export const PollWorkInteractionRequestsResultSchema = z.object({
	events: z.array(WorkInteractionRequestedEventSchema),
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

/**
 * `events/subscribe` webhook leases for the ledger events. The MCP edge
 * seals the caller's bearer and callback secret into `sealedCredential`; the
 * API stores it opaquely and returns it only to the service-bound deliverer.
 */
export const McpWebhookEventNameSchema = z.enum([
	"work.item.state_changed",
	"work.approval.requested",
	"work.item.commented",
	"work.interaction.requested",
	"skill.run.failed",
]);

const SubscriptionIdSchema = z
	.string()
	.regex(/^evsub_[0-9a-f]{64}$/, "Invalid subscription id");
const EventCursorSchema = z.string().min(1).max(512);

export const UpsertMcpEventWebhookSubscriptionInputSchema = z.object({
	id: SubscriptionIdSchema,
	eventName: McpWebhookEventNameSchema,
	arguments: z.record(z.string().max(64), z.string().max(128)),
	mcpUrl: z.string().url().max(2048),
	callbackUrl: z.string().url().max(2048),
	sealedCredential: z.string().min(1).max(16_384),
	/** Starting feed position for a new lease or an explicit resume. */
	cursor: EventCursorSchema,
	/** Keep the stored position when renewing a healthy lease. */
	keepCursor: z.boolean(),
	expiresAt: z.string().datetime(),
});

export const UpsertMcpEventWebhookSubscriptionResultSchema = z.object({
	id: SubscriptionIdSchema,
	cursor: EventCursorSchema,
	expiresAt: z.string(),
});

export const DeleteMcpEventWebhookSubscriptionInputSchema = z.object({
	id: SubscriptionIdSchema,
});

export const DeleteMcpEventWebhookSubscriptionResultSchema = z.object({
	deleted: z.boolean(),
});

export const ClaimDueMcpEventWebhooksInputSchema = z.object({
	limit: z.number().int().min(1).max(50).default(25),
	leaseMs: z.number().int().min(10_000).max(600_000).default(110_000),
});

export const McpEventWebhookSubscriptionSchema = z.object({
	id: SubscriptionIdSchema,
	organizationId: z.string(),
	ownerSubject: z.string(),
	mcpUrl: z.string(),
	eventName: McpWebhookEventNameSchema,
	arguments: z.record(z.string(), z.string()),
	callbackUrl: z.string(),
	sealedCredential: z.string(),
	cursor: EventCursorSchema,
	consecutiveFailures: z.number().int().min(0),
	rateWindowStartedAt: z.string().nullable(),
	rateWindowCount: z.number().int().min(0),
	expiresAt: z.string(),
});

export const ClaimDueMcpEventWebhooksResultSchema = z.object({
	subscriptions: z.array(McpEventWebhookSubscriptionSchema),
});

export const RecordMcpEventWebhookDeliveryInputSchema = z.object({
	id: SubscriptionIdSchema,
	organizationId: z.string().min(1).max(128),
	cursor: EventCursorSchema,
	status: z.enum(["active", "unhealthy"]),
	consecutiveFailures: z.number().int().min(0).max(1000),
	nextAttemptAt: z.string().datetime(),
	rateWindowStartedAt: z.string().datetime().nullable(),
	rateWindowCount: z.number().int().min(0),
	lastDeliveredAt: z.string().datetime().nullable(),
	lastStatus: z.number().int().min(0).max(999).nullable(),
});

export const RecordMcpEventWebhookDeliveryResultSchema = z.object({
	recorded: z.boolean(),
});
