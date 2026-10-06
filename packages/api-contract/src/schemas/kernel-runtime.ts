import { KernelPricingEvidenceSchema } from "./cost-provenance";
import * as z from "zod";
import {
	ConversationListCursorSchema,
	TediArtifactSchema,
	TediMessageAttachmentSchema,
	TediMessageRoleSchema,
	TediMessageStatusSchema,
	TediRunStatusSchema,
	TediRuntimeBackendSchema,
	TediRuntimeEventKindSchema,
	TediRuntimeEventSchema,
	TediRuntimeRefSchema,
} from "./cognitive-runtime";
import { ModelRefSchema } from "./model-catalog";
import { ExecutionRequirementSchema } from "./execution-evidence";
import { JsonValueSchema } from "./common";

const RuntimeMetadataSchema = z.record(z.string(), z.unknown());

export const ConversationCapabilityReplayNameSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[a-z][a-z0-9_]*$/);

export const ConversationCapabilitySchema = z.strictObject({
	id: z.uuid(),
	conversationId: z.string(),
	capabilityId: z.uuid(),
	replayName: ConversationCapabilityReplayNameSchema,
	name: z.string(),
	slug: z.string(),
	whyPresent: z.strictObject({
		type: z.enum([
			"user",
			"tedi",
			"service",
			"external_agent",
			"api_key",
			"m2m",
			"anonymous",
			"kernel",
		]),
		actorId: z.string(),
		attachedAt: z.string(),
	}),
	authority: z.literal("context_only"),
});
export type ConversationCapability = z.infer<
	typeof ConversationCapabilitySchema
>;

export const ConversationArtifactPinSchema = z.strictObject({
	id: z.uuid(),
	conversationId: z.string(),
	artifactId: z.string().min(1).max(200),
	replayName: ConversationCapabilityReplayNameSchema,
	revision: z.strictObject({
		algorithm: z.literal("sha256"),
		digest: z.string().regex(/^[a-f0-9]{64}$/),
	}),
	artifact: z.strictObject({
		name: z.string(),
		kind: z.string(),
		mimeType: z
			.string()
			.nullable()
			.describe(
				"Artifact media type when the publisher supplied one; null preserves artifacts created before media-type capture.",
			),
		uri: z.string(),
	}),
	state: z.enum(["active", "stale"]),
	whyPresent: z.strictObject({
		type: ConversationCapabilitySchema.shape.whyPresent.shape.type,
		actorId: z.string(),
		attachedAt: z.string(),
	}),
	authority: z.literal("context_only"),
});
export type ConversationArtifactPin = z.infer<
	typeof ConversationArtifactPinSchema
>;

export const HomeAttentionRouteSchema = z.object({
	id: z.string(),
	ownerTediId: z.string().nullable().optional(),
	ownerLabel: z.string(),
	routeKind: z.enum(["home", "agent", "workstation", "workflow", "human"]),
	confidence: z.number().min(0).max(1),
	risk: z.enum(["low", "medium", "high"]).default("low"),
	novelty: z.enum(["known", "mixed", "new"]).default("known"),
	rationale: z.string(),
	policy: z.string(),
	outcome: z
		.enum(["proposed", "approved", "dispatched", "completed", "rejected"])
		.default("proposed"),
});
export type HomeAttentionRoute = z.infer<typeof HomeAttentionRouteSchema>;

export const HomePlanAssignmentSchema = z.object({
	id: z.string(),
	ownerTediId: z.string(),
	ownerSlug: z.string().nullable().optional(),
	ownerLabel: z.string(),
	routeKind: z.enum(["agent", "workstation", "workflow", "human"]),
	objective: z.string(),
	expectedEvidence: z.array(z.string()).default([]),
	risk: z.enum(["low", "medium", "high"]).default("low"),
	confidence: z.number().min(0).max(1),
	requiresApproval: z.boolean().default(true),
	/**
	 * Required branches determine whether the plan can succeed. Optional branches
	 * are still awaited, traced, and synthesized, but a terminal failure/cancel on
	 * an optional branch does not fail an otherwise successful plan.
	 */
	required: z.boolean(),
	status: z
		.enum([
			"proposed",
			"approved",
			"queued",
			"running",
			"completed",
			"failed",
			"canceled",
		])
		.default("proposed"),
	workItemId: z.string().nullable().optional(),
	childRunId: z.string().nullable().optional(),
	childConversationId: z.string().nullable().optional(),
	approvedAt: z.string().nullable().optional(),
	dispatchedAt: z.string().nullable().optional(),
	error: z.string().nullable().optional(),
});
export type HomePlanAssignment = z.infer<typeof HomePlanAssignmentSchema>;

export const HomePlanSchema = z.object({
	id: z.string(),
	status: z
		.enum([
			"proposed",
			"approved",
			"dispatching",
			"completed",
			"failed",
			"canceled",
		])
		.default("proposed"),
	summary: z.string(),
	source: z.string().default("kernelRuntime.plan.v0"),
	createdAt: z.string(),
	/** Objective inherited by every approved assignment Work Item, when present. */
	objectiveId: z.string().nullable().optional(),
	assignments: z.array(HomePlanAssignmentSchema),
	attentionRoutes: z.array(HomeAttentionRouteSchema).default([]),
	// Inferred cross-owner dependency edges, computed at PROPOSE time (before any
	// Work Item exists) so they are keyed by ownerTediId, not workItemId — each
	// owner maps 1:1 to one assignment (HomePlanAssignmentSchema.ownerTediId).
	// Direction is BLOCKER → DEPENDENT: `fromOwnerTediId` finishes first and
	// `toOwnerTediId` waits on it. At approval time this maps directly (no flip)
	// to a work_item_relations row {relationType:"blocks", fromWorkItemId=from,
	// toWorkItemId=to}, which queryWorkItemBlockers reads as "from blocks to".
	dependencies: z.array(
		z.object({
			fromOwnerTediId: z.string(),
			toOwnerTediId: z.string(),
			reason: z.string(),
		}),
	),
});
export type HomePlan = z.infer<typeof HomePlanSchema>;

export const DelegationWorkOrderStatusSchema = z.enum([
	"draft",
	"requires_approval",
	"approved_waiting_certified_dispatch",
	"dispatched",
	"completed",
	"failed",
	"rejected",
]);
export type DelegationWorkOrderStatus = z.infer<
	typeof DelegationWorkOrderStatusSchema
>;

/**
 * Bounded-authority budget for a delegated specialist run (the "specialist
 * profile" delegation already carries owner tedi, capabilities, tools,
 * boundaries, authority, and output contract on the work order; this adds the
 * one missing piece — explicit caps). Caps are advisory inputs to the
 * executor/policy layer; an omitted cap means "no explicit cap from the work
 * order" and the target tedi's own profile/policy budgets still apply.
 */
export const DelegationBudgetSchema = z.object({
	maxToolCalls: z.number().int().positive().optional(),
	maxTokens: z.number().int().positive().optional(),
	maxUsd: z.number().nonnegative().optional(),
	deadlineMs: z.number().int().positive().optional(),
});
export type DelegationBudget = z.infer<typeof DelegationBudgetSchema>;

/**
 * Machine-readable task authority carried from the Kernel's independently
 * applied entrustment through the delegated child's durable workflow. This is
 * an execution ceiling, not prompt guidance: the child runtime exposes only
 * the exact local tool keys and namespaced MCP callables listed here.
 */
export const DelegationAuthorityEnvelopeSchema = z.object({
	version: z.literal("earned-delegation.v1"),
	grantId: z.string().min(1),
	grantRevision: z.number().int().positive(),
	decisionId: z.string().min(1),
	activityId: z.string().min(1),
	activityVersion: z.number().int().positive(),
	taskFamily: z.string().min(1),
	riskLevel: z.enum(["low", "medium", "high", "critical"]),
	environment: z.string().min(1),
	allowedToolIds: z.array(z.string().min(1)).max(64),
	expiresAt: z.string().nullable(),
});
export type DelegationAuthorityEnvelope = z.infer<
	typeof DelegationAuthorityEnvelopeSchema
>;

export const DelegationContractSchema = z.object({
	successCriteria: z.array(z.string()),
	budgetHint: z.string(),
	deadlineHint: z.string(),
	failurePolicy: z.string(),
});
export type DelegationContract = z.infer<typeof DelegationContractSchema>;

/** Operator-supplied verify command carried by a delegation (bounded). */
export const DelegationVerifyCommandSchema = z.string().trim().min(1).max(500);

export const DelegationWorkOrderSchema = z.object({
	id: z.string().optional(),
	approvalRequestId: z.string().optional(),
	kind: z
		.enum(["tedi.delegate", "workstation.attach"])
		.default("tedi.delegate"),
	status: DelegationWorkOrderStatusSchema.default("draft"),
	targetTediId: z.string(),
	targetTediLabel: z.string().optional(),
	objective: z.string(),
	outputContract: z.string(),
	toolGuidance: z.array(z.string()).default([]),
	boundaries: z.array(z.string()).default([]),
	executionRequirement: ExecutionRequirementSchema,
	contract: DelegationContractSchema,
	traceExcerpts: z.array(z.string()).default([]),
	projectValidation: z.boolean().default(false),
	outputSchema: z.record(z.string(), z.unknown()).nullable(),
	// Specialist bounded-authority caps; see DelegationBudgetSchema.
	budget: DelegationBudgetSchema.optional(),
	/**
	 * The entrustment grant Home matched at dispatch. When present the child
	 * runtime evaluates every tool call against it (shadow records, enforce
	 * denies). Absent means the dispatch was authorized by the decision itself
	 * (operator, approval, or autonomous dispatch); the child then runs on the
	 * supervised ceiling with no per-tool authority evaluation.
	 */
	authorityEnvelope: DelegationAuthorityEnvelopeSchema.optional(),
	authorityMode: z.enum(["shadow", "enforce"]).default("shadow"),
	sourceContent: z.string(),
	requestPreview: z.string().optional(),
	resultContract: RuntimeMetadataSchema.optional(),
	/**
	 * An exact command the child must run in its own environment before it
	 * reports, quoting the final output under a `Verification output:` heading.
	 * Home downgrades a success report that lacks that section to partial.
	 */
	verifyCommand: DelegationVerifyCommandSchema.optional().describe(
		"Absent when the operator did not pass --verify; only an explicit delegation carries a verify command.",
	),
});
export type DelegationWorkOrder = z.infer<typeof DelegationWorkOrderSchema>;

/**
 * Who started a Home conversation: a human operator at an interactive surface,
 * or machine traffic (MCP probes, smoke tests, crons, tedis, coding agents).
 *
 * Classified from the originating request's authenticated principal class at
 * turn ingress — never from the conversation title, which a human is free to
 * make look like anything.
 */
export const HomeConversationOriginSchema = z.enum(["human", "agent"]);
export type HomeConversationOrigin = z.infer<
	typeof HomeConversationOriginSchema
>;

/**
 * Read a conversation's origin with the ONE safe default: absent means human.
 *
 * Absent is the normal case for every conversation that existed before the
 * stamp shipped (nothing was backfilled) and for the fail-soft legacy
 * event-window derivation. Consumers must route absent to `human` — treating
 * it as `agent` would hide the operator's entire existing history.
 */
export function homeConversationOrigin(conversation: {
	origin?: HomeConversationOrigin | null;
}): HomeConversationOrigin {
	return conversation.origin === "agent" ? "agent" : "human";
}

export const HomeConversationSchema = z.object({
	id: z.string(),
	organizationId: z.string(),
	title: z.string().nullable().optional(),
	status: z.enum(["active", "archived", "deleted"]).default("active"),
	channel: z.string().nullable().optional(),
	lastMessageAt: z.string().nullable().optional(),
	messageCount: z.number().int().nonnegative().optional(),
	createdAt: z.string(),
	updatedAt: z.string().nullable().optional(),
	/**
	 * Pin marker — non-null ISO timestamp when pinned, null/absent otherwise.
	 * Org-durable and shared across Tedix OS + CLI (set via `kernelRuntime.pinConversation`);
	 * each surface sorts pinned-first in its own read.
	 */
	pinnedAt: z.string().nullable().optional(),
	/**
	 * Conversation-origin stamp. Optional on purpose: absent/null is
	 * "unstamped", which every pre-stamp row is, and it reads as `human`. Go
	 * through {@link homeConversationOrigin} instead of testing this field.
	 */
	origin: HomeConversationOriginSchema.nullable().optional(),
	/** Durable Workspace association. Null/absent means an organization Home thread. */
	workspaceId: z
		.string()
		.nullable()
		.optional()
		.describe(
			"Absent/null for organization Home threads and historical conversations created before Workspace association shipped.",
		),
	/** Last selected Workspace workpiece, retained for session switching/provenance. */
	workpiece: z
		.object({ kind: z.enum(["gadget", "output"]), id: z.string() })
		.nullable()
		.optional()
		.describe(
			"Absent/null when the Workspace conversation has no selected Gadget or Output.",
		),
	metadata: RuntimeMetadataSchema.optional(),
});
export type HomeConversation = z.infer<typeof HomeConversationSchema>;

export const HomeMessageSchema = z.object({
	id: z.string(),
	organizationId: z.string(),
	conversationId: z.string(),
	runId: z.string().optional(),
	delegatedTediId: z.string().optional(),
	childRunId: z.string().optional(),
	role: TediMessageRoleSchema,
	status: TediMessageStatusSchema,
	content: z.string().default(""),
	attachments: z.array(TediMessageAttachmentSchema).optional(),
	runtime: TediRuntimeRefSchema.optional(),
	createdAt: z.string(),
	startedAt: z.string().nullable().optional(),
	completedAt: z.string().nullable().optional(),
	metadata: RuntimeMetadataSchema.optional(),
});
export type HomeMessage = z.infer<typeof HomeMessageSchema>;

/**
 * Compact per-run token usage surfaced in the run-set summary.
 * All fields are nullable — absent means the provider did not report it.
 * `totalTokens` is the sum of `inputTokens + outputTokens` (null when either
 * is unavailable). `costUsd` derives from model pricing in the kernel turn body.
 * Fail-soft: the entire field is omitted when no usage data was recorded
 * (delegated tedi runs, non-kernel turns, or pre-migration runs).
 */
export const HomeRunUsageSchema = z.object({
	pricing: KernelPricingEvidenceSchema.nullable().describe(
		"Null for historical or non-inference results without immutable attempt evidence; never interpreted as a known zero.",
	),
	inputTokens: z.number().nullable(),
	outputTokens: z.number().nullable(),
	reasoningTokens: z
		.number()
		.nullable()
		.describe("Null when the provider does not report reasoning token usage"),
	totalTokens: z.number().nullable(),
	costUsd: z.number().nullable(),
});
export type HomeRunUsage = z.infer<typeof HomeRunUsageSchema>;

export const HomeRunSchema = z.object({
	id: z.string(),
	organizationId: z.string(),
	conversationId: z.string(),
	status: TediRunStatusSchema,
	inputMessageId: z.string().optional(),
	outputMessageId: z.string().nullable().optional(),
	delegatedTediId: z.string().nullable().optional(),
	childRunId: z.string().nullable().optional(),
	runtime: TediRuntimeRefSchema.optional(),
	startedAt: z.string().nullable().optional(),
	completedAt: z.string().nullable().optional(),
	timeoutAt: z.string().nullable().optional(),
	createdAt: z.string(),
	updatedAt: z.string().nullable().optional(),
	progress: z
		.object({
			current: z.number().int().min(0).max(100),
			total: z.number().int().positive().default(100),
			detail: z.string().nullable().optional(),
			label: z.string(),
		})
		.optional(),
	/**
	 * Per-run token usage from the kernel route-planner LLM call.
	 * Present on completed kernel turns; omitted when no usage was recorded
	 * (delegated/queued runs, fail-soft turns, or pre-migration run rows).
	 */
	usage: HomeRunUsageSchema.optional(),
	metadata: RuntimeMetadataSchema.optional(),
});
export type HomeRun = z.infer<typeof HomeRunSchema>;

export const HomeApprovalMirrorSchema = z.object({
	id: z.string(),
	parentConversationId: z.string(),
	childRunId: z.string(),
	approvalRequestId: z.string(),
	delegatedTediId: z.string().nullable().optional(),
	status: z.enum(["pending", "escalated"]),
	blockedAt: z.string(),
	escalateAt: z.number().int(),
	escalatedAt: z.string().nullable().optional(),
});
export type HomeApprovalMirror = z.infer<typeof HomeApprovalMirrorSchema>;

export const HomeRunSetSchema = z.object({
	organizationId: z.string(),
	conversationId: z.string(),
	activeRunIds: z.array(z.string()),
	runs: z.array(HomeRunSchema),
	// Absent for compact summary responses or when the rebuildable approval projection cannot be read.
	approvalMirrors: z.record(z.string(), HomeApprovalMirrorSchema).optional(),
	updatedAt: z.string().nullable().optional(),
	metadata: RuntimeMetadataSchema.optional(),
});
export type HomeRunSet = z.infer<typeof HomeRunSetSchema>;

export const KernelRuntimeEventSchema = z.object({
	id: z.string(),
	organizationId: z.string(),
	kind: TediRuntimeEventKindSchema,
	conversationId: z.string(),
	runId: z.string().optional(),
	messageId: z.string().optional(),
	causeEventId: z
		.string()
		.min(1)
		.nullable()
		.optional()
		.describe(
			"Absent or null for legacy events and events without an explicitly recorded cause; never inferred during replay.",
		),
	delegatedTediId: z.string().nullable().optional(),
	childRunId: z.string().nullable().optional(),
	sequence: z.number().int().nonnegative().optional(),
	delta: z.string().optional(),
	payload: RuntimeMetadataSchema.optional(),
	runtime: z
		.object({
			backend: TediRuntimeBackendSchema,
			externalId: z.string().optional(),
			externalUrl: z.string().optional(),
			metadata: RuntimeMetadataSchema.optional(),
		})
		.optional(),
	createdAt: z.string(),
});
export type KernelRuntimeEvent = z.infer<typeof KernelRuntimeEventSchema>;

export const ListHomeConversationsInputSchema = z.object({
	organizationId: z.string().optional(),
	limit: z.number().int().positive().max(500).optional(),
	cursor: ConversationListCursorSchema.optional(),
	search: z.string().optional(),
	channel: z.string().optional(),
	includeArchived: z.boolean().optional(),
	/** Restrict the conversation projection to one canonical Workspace. */
	workspaceId: z
		.string()
		.optional()
		.describe(
			"Omitted for the organization-wide Home list; set by Workspace surfaces to isolate their durable sessions.",
		),
});
export type ListHomeConversationsInput = z.infer<
	typeof ListHomeConversationsInputSchema
>;

export const ReadHomeMessagesInputSchema = z.object({
	organizationId: z.string().optional(),
	conversationId: z.string(),
	limit: z.number().int().positive().max(500).optional(),
	cursor: z.string().optional(),
});
export type ReadHomeMessagesInput = z.infer<typeof ReadHomeMessagesInputSchema>;

export const ReadHomeRunSetInputSchema = z.object({
	organizationId: z.string().optional(),
	conversationId: z.string(),
	limit: z.number().int().positive().max(100).optional(),
	/**
	 * Zero-based row offset into the conversation's runs, newest-first
	 * (`updatedAt DESC`). Default 0 — callers that omit it page the head exactly
	 * as before. Paired with `limit` it lets the Home cockpit fetch a small fast
	 * first page (offset 0) at SSR time and backfill the remaining runs
	 * client-side, page by page, so a heavy workspace paints full Home data fast
	 * instead of degrading at the SSR read timeout.
	 */
	offset: z.number().int().nonnegative().optional(),
	/**
	 * Compact projection for agent context budgets: omits
	 * per-run `metadata` bags and the `approvalMirrors` rendering projection,
	 * keeping run identity, status, timing, progress, and usage. Cockpit/SSR
	 * callers keep the full shape by omitting this.
	 */
	summary: z.boolean().optional(),
});
export type ReadHomeRunSetInput = z.infer<typeof ReadHomeRunSetInputSchema>;

export const HomeChildRunStatusSchema = z.enum([
	"queued",
	"running",
	"streaming",
	"requires_approval",
	"partial",
	"completed",
	"failed",
	"canceled",
]);
export type HomeChildRunStatus = z.infer<typeof HomeChildRunStatusSchema>;

export const ReadHomeChildRunEvidenceInputSchema = z.object({
	organizationId: z.string().optional(),
	delegatedTediId: z.string(),
	childRunId: z.string(),
	limit: z.number().int().positive().max(500).optional(),
	artifactLimit: z.number().int().positive().max(100).optional(),
});
export type ReadHomeChildRunEvidenceInput = z.infer<
	typeof ReadHomeChildRunEvidenceInputSchema
>;

export const HomeChildRunEvidenceSchema = z.object({
	organizationId: z.string(),
	delegatedTediId: z.string(),
	childRunId: z.string(),
	workItemId: z.string().nullable().optional(),
	observedRunIds: z.array(z.string()).optional(),
	status: HomeChildRunStatusSchema,
	latestEventAt: z.string().nullable().optional(),
	latestEventKind: TediRuntimeEventKindSchema.nullable().optional(),
	terminalAt: z.string().nullable().optional(),
	terminalEventKind: TediRuntimeEventKindSchema.nullable().optional(),
	stopReason: z.string().nullable(),
	preview: z.string().nullable().optional(),
	events: z.array(TediRuntimeEventSchema),
	artifacts: z.array(TediArtifactSchema),
	control: z.object({
		canStop: z.boolean(),
		reason: z.string(),
		state: z.enum(["stoppable", "terminal", "unknown"]),
	}),
	populated: z.boolean().optional(),
	storeHealthy: z.boolean().optional(),
});
export type HomeChildRunEvidence = z.infer<typeof HomeChildRunEvidenceSchema>;

export const ReadHomeChildRunTreeInputSchema = z.object({
	organizationId: z.string().optional(),
	conversationId: z.string(),
	limit: z.number().int().positive().max(100).optional(),
});
export type ReadHomeChildRunTreeInput = z.infer<
	typeof ReadHomeChildRunTreeInputSchema
>;

export type HomeChildRunTreeNode = {
	id: string;
	homeRunId: string;
	conversationId: string;
	delegatedTediId: string | null;
	childRunId: string | null;
	parentRunId: string | null;
	label: string;
	status: HomeChildRunStatus;
	active: boolean;
	depth: number;
	updatedAt: string | null;
	children: HomeChildRunTreeNode[];
	metadata?: Record<string, unknown>;
};

export const HomeChildRunTreeNodeSchema: z.ZodType<HomeChildRunTreeNode> =
	z.lazy(() =>
		z.object({
			id: z.string(),
			homeRunId: z.string(),
			conversationId: z.string(),
			delegatedTediId: z.string().nullable(),
			childRunId: z.string().nullable(),
			parentRunId: z.string().nullable(),
			label: z.string(),
			status: HomeChildRunStatusSchema,
			active: z.boolean(),
			depth: z.number().int().nonnegative(),
			updatedAt: z.string().nullable(),
			children: z.array(HomeChildRunTreeNodeSchema),
			metadata: RuntimeMetadataSchema.optional(),
		}),
	);

export const HomeChildRunTreeSchema = z.object({
	organizationId: z.string(),
	conversationId: z.string(),
	nodes: z.array(HomeChildRunTreeNodeSchema),
	activeNodeId: z.string().nullable().optional(),
	updatedAt: z.string().nullable().optional(),
});
export type HomeChildRunTree = z.infer<typeof HomeChildRunTreeSchema>;

export const ResolveHomeDelegationWorkOrderInputSchema = z.object({
	organizationId: z.string().optional(),
	approvalRequestId: z.string().min(1),
	status: z.enum(["approved", "rejected"]),
	resolution: z.string().max(2000).optional(),
});
export type ResolveHomeDelegationWorkOrderInput = z.infer<
	typeof ResolveHomeDelegationWorkOrderInputSchema
>;

export const ApproveHomePlanAssignmentsInputSchema = z.object({
	organizationId: z.string().optional(),
	runId: z.string().min(1),
	assignmentIds: z.array(z.string().min(1)).optional(),
	dispatch: z.boolean().default(true),
	approvalNote: z.string().max(2000).optional(),
});
export type ApproveHomePlanAssignmentsInput = z.infer<
	typeof ApproveHomePlanAssignmentsInputSchema
>;

export const HomePlanAssignmentApprovalResultSchema = z.object({
	assignmentId: z.string(),
	ownerTediId: z.string(),
	status: HomePlanAssignmentSchema.shape.status,
	workItemId: z.string(),
	childRunId: z.string().nullable().optional(),
	childConversationId: z.string().nullable().optional(),
	error: z.string().nullable().optional(),
});
export type HomePlanAssignmentApprovalResult = z.infer<
	typeof HomePlanAssignmentApprovalResultSchema
>;

export const KernelExecutionPolicySchema = z.enum(["normal", "observe_only"]);
export type KernelExecutionPolicy = z.infer<typeof KernelExecutionPolicySchema>;

export const EnqueueHomeMessageInputSchema = z.object({
	organizationId: z.string().optional(),
	conversationId: z.string().optional(),
	// Empty content is valid for attachment-only sends (voice notes record ""
	// typed text); "content OR attachments" is enforced in the router handler.
	content: z.string(),
	idempotencyKey: z.string().min(1).optional(),
	delegateToTediId: z.string().optional(),
	executionPolicy: KernelExecutionPolicySchema.default("normal").describe(
		"Server-enforced authority ceiling. observe_only preserves the Kernel route decision but forbids attachments, delegation, approvals, writes, and workflow execution.",
	),
	/**
	 * Verify command for an explicit delegation: the child runs it before
	 * reporting and quotes its output; Home treats a success report without a
	 * `Verification output:` section as partial.
	 */
	verifyCommand: DelegationVerifyCommandSchema.optional().describe(
		"Omitted unless the operator passes --verify with an explicit delegation; ordinary Home turns carry none.",
	),
	/** A per-turn request. The server revalidates it against the caller's live catalog. */
	modelRef: ModelRefSchema.optional().describe(
		"Optional per-turn model request. Omission preserves the organization routing default; a supplied ref is admitted against the caller's live model catalog before Kernel use.",
	),
	attachments: z.array(TediMessageAttachmentSchema).optional(),
	/**
	 * Workspace/workpiece selection supplied by the host UI. The API resolves and
	 * tenant-validates every id before it reaches the ledger or Kernel prompt.
	 */
	workspaceContext: z
		.object({
			workspaceId: z.string().min(1),
			workpiece: z
				.object({ kind: z.enum(["gadget", "output"]), id: z.string().min(1) })
				.optional()
				.describe(
					"Omitted when Chat is scoped to the Workspace rather than one selected Gadget or Output.",
				),
		})
		.optional()
		.describe(
			"Omitted on organization Home turns; Workspace hosts supply it and the API tenant-validates every id.",
		),
	metadata: RuntimeMetadataSchema.optional(),
});
export type EnqueueHomeMessageInput = z.input<
	typeof EnqueueHomeMessageInputSchema
>;

export const EnqueueHomeMessageOutputSchema = z.object({
	idempotencyKey: z.string(),
	conversationId: z.string(),
	status: z.enum(["queued", "failed", "needs_delegation", "requires_approval"]),
	run: HomeRunSchema,
	homePlan: HomePlanSchema.optional(),
	assistantMessage: HomeMessageSchema.optional(),
	error: z.string().optional(),
});
export type EnqueueHomeMessageOutput = z.infer<
	typeof EnqueueHomeMessageOutputSchema
>;

/**
 * An explicit operator-issued, read-only MCP call. This is intentionally not
 * a Home message: Home remains a pure router, while the API verifies the live
 * tool catalog and persists a bounded transcript receipt for the caller.
 */
export const ExecuteHomeReadOnlyToolInputSchema = z.object({
	organizationId: z
		.string()
		.optional()
		.describe(
			"Optional only because the authenticated caller organization is authoritative when omitted.",
		),
	conversationId: z.string().min(1),
	workspaceContext: z
		.object({
			workspaceId: z.string().min(1),
			workpiece: z
				.object({ kind: z.enum(["gadget", "output"]), id: z.string().min(1) })
				.optional()
				.describe(
					"Omitted when the direct read belongs to the Workspace conversation rather than one selected workpiece.",
				),
		})
		.optional()
		.describe(
			"Omitted on organization Chat; Workspace hosts supply it so the API can validate and persist the conversation association.",
		),
	appSlug: z.string().min(1).max(120),
	toolName: z.string().min(1).max(200),
	arguments: z.record(z.string(), JsonValueSchema).default({}),
	idempotencyKey: z.string().min(1).max(200),
});
export type ExecuteHomeReadOnlyToolInput = z.infer<
	typeof ExecuteHomeReadOnlyToolInputSchema
>;

export const ExecuteHomeReadOnlyToolOutputSchema = z.object({
	requestMessage: HomeMessageSchema,
	receiptMessage: HomeMessageSchema,
});
export type ExecuteHomeReadOnlyToolOutput = z.infer<
	typeof ExecuteHomeReadOnlyToolOutputSchema
>;

export const KernelToolResultReferenceSchema = z.strictObject({
	id: z.uuid(),
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
	byteSize: z
		.number()
		.int()
		.nonnegative()
		.max(1024 * 1024),
	expiresAt: z.string(),
});

export const ReadKernelToolResultInputSchema = z.strictObject({
	organizationId: z
		.string()
		.optional()
		.describe(
			"Optional for client compatibility; the authenticated caller organization remains authoritative when omitted or supplied.",
		),
	conversationId: z.string().min(1),
	resultId: z.uuid(),
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
	mode: z.enum(["page", "search"]).default("page"),
	offset: z.number().int().nonnegative().default(0),
	query: z
		.string()
		.min(1)
		.max(4_096)
		.optional()
		.describe("Required in search mode and unused in page mode."),
});

export const ReadKernelToolResultOutputSchema = z.strictObject({
	resultId: z.uuid(),
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
	byteSize: z.number().int().nonnegative(),
	content: z.string(),
	matchOffset: z
		.number()
		.int()
		.nonnegative()
		.nullable()
		.describe(
			"Unicode code-point offset of a search match; null for page mode or no match.",
		),
	nextOffset: z
		.number()
		.int()
		.nonnegative()
		.nullable()
		.describe(
			"Unicode code-point offset for the next page; null at the end or when search has no match.",
		),
});

export const HomeReadOnlyToolSchema = z.object({
	name: z.string(),
	title: z.string(),
	description: z
		.string()
		.nullable()
		.describe("Null when the live tool declaration has no description."),
	inputSchema: JsonValueSchema,
	connectionState: z.enum(["connected", "connection_required", "unavailable"]),
	connectionReason: z
		.string()
		.nullable()
		.describe(
			"Operator-facing explanation of the current connection state; null when the tool is callable.",
		),
	connectProviderId: z
		.string()
		.nullable()
		.describe(
			"Descope outbound-app id for an operator connection handoff; null when no connection action can repair the state.",
		),
});

export const HomeReadOnlyAppSchema = z.object({
	slug: z.string(),
	name: z.string(),
	logoUrl: z
		.string()
		.nullable()
		.describe("Null when the organization app has no configured logo."),
	connectionState: z.enum(["connected", "connection_required", "unavailable"]),
	tools: z.array(HomeReadOnlyToolSchema),
});

export const ListHomeReadOnlyToolsInputSchema = z.object({
	organizationId: z
		.string()
		.optional()
		.describe(
			"Omitted when the authenticated caller credential already supplies the authoritative organization.",
		),
});

export const ListHomeReadOnlyToolsOutputSchema = z.object({
	apps: z.array(HomeReadOnlyAppSchema),
});

export type HomeReadOnlyApp = z.infer<typeof HomeReadOnlyAppSchema>;

export const ReadHomeRunInputSchema = z.object({
	organizationId: z.string().optional(),
	runId: z.string().min(1),
});
export type ReadHomeRunInput = z.infer<typeof ReadHomeRunInputSchema>;

export const HomeRunTraceBranchSchema = z.object({
	delegatedTediId: z.string(),
	childRunId: z.string(),
	workItemId: z.string().nullable(),
	status: HomeChildRunStatusSchema,
	observedRunIds: z.array(z.string()),
	eventIds: z.array(z.string()),
	auditEventIds: z.array(z.string()).default([]),
	toolEventIds: z.array(z.string()),
	workstationEventIds: z.array(z.string()),
	artifactIds: z.array(z.string()),
	finalMessageEventId: z.string().nullable(),
	terminalEventId: z.string().nullable(),
	latestEventAt: z.string().nullable(),
	evidenceAvailable: z.boolean(),
	truncated: z.boolean(),
});
export type HomeRunTraceBranch = z.infer<typeof HomeRunTraceBranchSchema>;

export const HomeRunTraceWakeReceiptSchema = z.object({
	id: z.string(),
	childRunId: z.string(),
	childStatus: z.string(),
	queuedAt: z.string(),
	ackedAt: z.string().nullable(),
	queueLatencyMs: z.number().int().nonnegative().nullable(),
});

export const HomeRunTraceSynthesisSchema = z.object({
	runId: z.string(),
	eventId: z.string(),
	childRunIds: z.array(z.string()),
	contentPreview: z.string().nullable(),
	createdAt: z.string(),
});

export const HomeRunTraceLatencySchema = z.object({
	/** Parent run wall time from durable creation to terminal completion. */
	parentElapsedMs: z.number().int().nonnegative().nullable(),
	/** Slowest acknowledged child-completion wake queue hop. */
	maxWakeQueueMs: z.number().int().nonnegative().nullable(),
	/** Final child wake notification to the canonical synthesis event. */
	finalWakeToSynthesisMs: z.number().int().nonnegative().nullable(),
});

export const HomeRunConvergenceHealthCodeSchema = z.enum([
	"terminal_child_without_wake",
	"acknowledged_wake_without_synthesis",
	"parent_completed_with_required_child_active",
	"child_evidence_missing",
	"child_evidence_truncated",
	"orphaned_workstation_reference",
	"repeated_synthesis_failures",
	"repeated_redrive_failures",
]);

export const HomeRunConvergenceHealthFindingSchema = z.object({
	code: HomeRunConvergenceHealthCodeSchema,
	severity: z.enum(["error", "warning"]),
	childRunId: z.string().nullable(),
	referenceId: z.string().nullable(),
	detail: z.string(),
});

export const HomeRunConvergenceHealthSchema = z.object({
	status: z.enum(["healthy", "degraded", "unhealthy"]),
	findings: z.array(HomeRunConvergenceHealthFindingSchema),
	counts: z.object({
		errors: z.number().int().nonnegative(),
		warnings: z.number().int().nonnegative(),
	}),
});
export type HomeRunConvergenceHealth = z.infer<
	typeof HomeRunConvergenceHealthSchema
>;

/**
 * Read-time convergence over canonical Kernel, tedi-runtime, artifact, and
 * wake ledgers. This is a reference graph, not a copied event store: ids point
 * back to their owning ledgers and callers use the existing evidence/event
 * reads for payload inspection.
 */
export const HomeRunTraceSchema = z.object({
	version: z.literal("home-run-trace.v1"),
	organizationId: z.string(),
	conversationId: z.string(),
	homeRunId: z.string(),
	traceBundleId: z.string().nullable(),
	harnessVersionId: z.string().nullable(),
	status: TediRunStatusSchema,
	parentEventIds: z.array(z.string()),
	branches: z.array(HomeRunTraceBranchSchema),
	wakeReceipts: z.array(HomeRunTraceWakeReceiptSchema),
	synthesis: z.array(HomeRunTraceSynthesisSchema),
	latency: HomeRunTraceLatencySchema,
	eventIds: z.object({
		kernel: z.array(z.string()),
		tedi: z.array(z.string()),
		audit: z.array(z.string()).default([]),
	}),
	artifactIds: z.array(z.string()),
	health: HomeRunConvergenceHealthSchema,
	complete: z.boolean(),
	gaps: z.array(z.string()),
	assembledAt: z.string(),
	sources: z.array(
		z.enum([
			"harness_subject_trace_bundles",
			"kernel_runtime_events",
			"tedi_runtime_events",
			"tedi_artifacts",
			"kernel_wake_queue",
			"audit_events",
		]),
	),
});
export type HomeRunTrace = z.infer<typeof HomeRunTraceSchema>;

export const ReadHomeRunEventsInputSchema = z.object({
	organizationId: z.string().optional(),
	runId: z.string().min(1),
	offset: z.number().int().nonnegative().optional(),
	tail: z.number().int().positive().optional(),
	// Bound one offset page. Defaults to the server page size; callers whose
	// transport caps the RESPONSE (the Code Mode gateway truncates a result over
	// its token limit, and a truncated page is indistinguishable from an empty
	// one) must page in slices small enough to survive that cap.
	limit: z
		.number()
		.int()
		.positive()
		.optional()
		.describe(
			"Optional for compatibility: existing readers (Tedix OS, the events SSE bridge) omit it and keep the full server page size. Absent means the server page size.",
		),
	waitMs: z.number().int().min(0).max(30000).optional(),
	// When set, scope the returned stream to a delegated child run's events
	// (events written with delegatedTediId + childRunId) instead of the parent
	// Home run's own events. delegatedTediId narrows further when a single
	// childRunId is reused across delegates.
	childRunId: z.string().min(1).optional(),
	delegatedTediId: z.string().min(1).optional(),
});
export type ReadHomeRunEventsInput = z.infer<
	typeof ReadHomeRunEventsInputSchema
>;

export const CancelHomeRunInputSchema = z.object({
	organizationId: z.string().optional(),
	runId: z.string().min(1),
	reason: z.string().max(2000).optional(),
});
export type CancelHomeRunInput = z.infer<typeof CancelHomeRunInputSchema>;

export const SteerHomeRunInputSchema = z.object({
	organizationId: z.string().optional(),
	runId: z.string().min(1),
	instruction: z.string().min(1).max(4000),
});
export type SteerHomeRunInput = z.infer<typeof SteerHomeRunInputSchema>;

export const RetryHomeRunInputSchema = z.object({
	organizationId: z.string().optional(),
	runId: z.string().min(1),
});
export type RetryHomeRunInput = z.infer<typeof RetryHomeRunInputSchema>;

export const RetryDelegationWorkItemInputSchema = z.object({
	organizationId: z.string().optional(),
	workItemId: z.string().min(1),
});
export type RetryDelegationWorkItemInput = z.infer<
	typeof RetryDelegationWorkItemInputSchema
>;

export const RespondHomeApprovalInputSchema = z.object({
	organizationId: z.string().optional(),
	runId: z.string().min(1),
	/**
	 * Required decision — respond_home_approval is THE Home approval surface.
	 * The target is resolved FROM THE RUN: a parked `home_tool_write` approval
	 * card, a Home delegation recommendation, a workstation attachment work
	 * order, or a proposed Home plan.
	 */
	decision: z.enum(["approve", "reject"]),
	/** Plan target only: optional subset of plan assignment ids. */
	assignmentIds: z.array(z.string().min(1)).optional(),
	note: z.string().max(2000).optional(),
});
export type RespondHomeApprovalInput = z.infer<
	typeof RespondHomeApprovalInputSchema
>;
