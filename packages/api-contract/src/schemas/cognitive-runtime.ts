/**
 * Cognitive Runtime Protocol Schemas
 * Runtime-neutral Tedix shapes for conversations, messages, runs, events,
 * tools, approvals, artifacts, status, and cognitive activity.
 */

import * as z from "zod";
import { BodyExecutionUsageSchema } from "./body-certification";
import { JsonValueSchema } from "./common";

// =============================================================================
// ENUM SCHEMAS
// =============================================================================

export const TediRuntimeBackendSchema = z.enum([
	"cloudflare-agents",
	"openai-agents",
	"claude",
	"codex",
	"google-adk",
	"langgraph",
	"custom",
]);
export type TediRuntimeBackend = z.infer<typeof TediRuntimeBackendSchema>;

export const TediRuntimeEventKindSchema = z.enum([
	"conversation.created",
	"conversation.updated",
	"message.received",
	"message.delta",
	"message.completed",
	"message.progress",
	"message.phase",
	"message.reasoning",
	"run.started",
	"run.completed",
	"run.failed",
	"run.canceled",
	"tool.started",
	"tool.completed",
	"tool.failed",
	"step.completed",
	"step.retry",
	"subagent.started",
	"subagent.completed",
	"subagent.failed",
	"approval.requested",
	"approval.resolved",
	"artifact.created",
	"context.injected",
	"context.compacted",
	"memory.observed",
	"memory.bridged",
	"memory.retrieved",
	"decision.recorded",
	"decision.completed",
	"delegation.authority.evaluated",
	"skill.used",
	"skill.failed",
	"skill.crystallized",
	"task.detected",
	"task.synced",
	"runtime.health_changed",
	"runtime.mirror_skipped",
	"submission.admitted",
	"submission.attempt.started",
	"submission.attempt.recovered",
	"submission.settled",
	"repo_commit.drained",
	"workstation.exec.completed",
	"workstation.exec.failed",
	"workstation.egress.allow",
	"workstation.egress.deny",
	"browser.egress.deny",
]);
export type TediRuntimeEventKind = z.infer<typeof TediRuntimeEventKindSchema>;

export const TediCognitiveActivityKindSchema = z.enum([
	"context.injected",
	"context.compacted",
	"context.directives",
	"memory.observed",
	"memory.persisted",
	"memory.bridged",
	"memory.retrieved",
	"decision.retrieved",
	"decision.recorded",
	"decision.completed",
	"skill.used",
	"skill.crystallized",
	"task.detected",
	"task.needs_context",
	"task.external_candidate",
	"task.sync_planned",
	"task.synced",
	"work_item.promoted",
]);
export type TediCognitiveActivityKind = z.infer<
	typeof TediCognitiveActivityKindSchema
>;

export const TediConversationStatusSchema = z.enum([
	"active",
	"archived",
	"deleted",
]);
export type TediConversationStatus = z.infer<
	typeof TediConversationStatusSchema
>;

export const TediMessageRoleSchema = z.enum([
	"system",
	"user",
	"assistant",
	"tool",
	"runtime",
]);
export type TediMessageRole = z.infer<typeof TediMessageRoleSchema>;

export const TediMessageStatusSchema = z.enum([
	"pending",
	"streaming",
	"completed",
	"failed",
	"canceled",
]);
export type TediMessageStatus = z.infer<typeof TediMessageStatusSchema>;

export const TediRunStatusSchema = z.enum([
	"queued",
	"running",
	"completed",
	"failed",
	"canceled",
	"requires_approval",
]);
export type TediRunStatus = z.infer<typeof TediRunStatusSchema>;

export const TediToolCallStatusSchema = z.enum([
	"queued",
	"running",
	"completed",
	"failed",
	"canceled",
	"requires_approval",
]);
export type TediToolCallStatus = z.infer<typeof TediToolCallStatusSchema>;

export const TediApprovalStatusSchema = z.enum([
	"pending",
	"approved",
	"rejected",
	"canceled",
	"expired",
]);
export type TediApprovalStatus = z.infer<typeof TediApprovalStatusSchema>;

export const TediRuntimeHealthSchema = z.enum([
	"healthy",
	"degraded",
	"unreachable",
	"starting",
	"stopped",
]);
export type TediRuntimeHealth = z.infer<typeof TediRuntimeHealthSchema>;

export const TediArtifactKindSchema = z.enum([
	"file",
	"image",
	"document",
	"spreadsheet",
	"presentation",
	"widget",
	"log",
	"link",
	"other",
]);
export type TediArtifactKind = z.infer<typeof TediArtifactKindSchema>;

export const TediRuntimeBackendDiagnosticsKindSchema = z.enum([
	"connection",
	"gateway",
	"lifecycle",
	"adapter",
	"unknown",
]);
export type TediRuntimeBackendDiagnosticsKind = z.infer<
	typeof TediRuntimeBackendDiagnosticsKindSchema
>;

export const TediLivenessVerdictSchema = z.enum([
	"alive",
	"maybe-alive",
	"absent",
]);
export type TediLivenessVerdict = z.infer<typeof TediLivenessVerdictSchema>;

// =============================================================================
// SHARED SCHEMAS
// =============================================================================

const RuntimeMetadataSchema = z.record(z.string(), z.unknown());

export const TediRuntimeRefSchema = z.object({
	backend: TediRuntimeBackendSchema,
	externalId: z.string().optional(),
	externalUrl: z.string().url().optional(),
	metadata: RuntimeMetadataSchema.optional(),
});
export type TediRuntimeRef = z.infer<typeof TediRuntimeRefSchema>;

export const TediArtifactSchema = z.object({
	id: z.string(),
	tediId: z.string(),
	conversationId: z.string().optional(),
	runId: z.string().optional(),
	messageId: z.string().optional(),
	kind: TediArtifactKindSchema,
	name: z.string(),
	mimeType: z.string().nullable().optional(),
	uri: z.string().optional(),
	sizeBytes: z.number().int().nonnegative().nullable().optional(),
	metadata: RuntimeMetadataSchema.optional(),
	accessClassification: z
		.enum(["explicit_shareable", "source_derived", "runtime_private"])
		.nullable()
		.optional()
		.describe(
			"Immutable byte-access classification; runtime_private is never a bearer capability",
		),
	createdAt: z.string(),
});
export type TediArtifact = z.infer<typeof TediArtifactSchema>;

export const TediToolResultSchema = z.object({
	id: z.string(),
	toolCallId: z.string(),
	status: z.enum(["completed", "failed", "canceled"]),
	output: z.unknown().optional(),
	error: z
		.object({
			code: z.string().optional(),
			message: z.string(),
			details: RuntimeMetadataSchema.optional(),
		})
		.optional(),
	startedAt: z.string().nullable().optional(),
	completedAt: z.string().nullable().optional(),
	metadata: RuntimeMetadataSchema.optional(),
});
export type TediToolResult = z.infer<typeof TediToolResultSchema>;

export const TediToolCallSchema = z.object({
	id: z.string(),
	tediId: z.string(),
	conversationId: z.string().optional(),
	runId: z.string().optional(),
	messageId: z.string().optional(),
	name: z.string(),
	provider: z.string().nullable().optional(),
	namespace: z.string().nullable().optional(),
	args: z.record(z.string(), z.unknown()).optional(),
	status: TediToolCallStatusSchema,
	result: TediToolResultSchema.optional(),
	approvalRequestId: z.string().nullable().optional(),
	startedAt: z.string().nullable().optional(),
	completedAt: z.string().nullable().optional(),
	metadata: RuntimeMetadataSchema.optional(),
});
export type TediToolCall = z.infer<typeof TediToolCallSchema>;

export const TediApprovalRequestSchema = z.object({
	id: z.string(),
	tediId: z.string(),
	conversationId: z.string().optional(),
	runId: z.string().optional(),
	toolCallId: z.string().optional(),
	actionType: z.string(),
	title: z.string(),
	description: z.string().nullable().optional(),
	payload: RuntimeMetadataSchema.optional(),
	status: TediApprovalStatusSchema,
	requestedBy: z.string().nullable().optional(),
	resolvedBy: z.string().nullable().optional(),
	resolution: z.string().nullable().optional(),
	expiresAt: z.string().nullable().optional(),
	createdAt: z.string(),
	resolvedAt: z.string().nullable().optional(),
	metadata: RuntimeMetadataSchema.optional(),
});
export type TediApprovalRequest = z.infer<typeof TediApprovalRequestSchema>;

export const TediCognitiveActivitySchema = z.object({
	id: z.string().optional(),
	kind: TediCognitiveActivityKindSchema,
	tediId: z.string().optional(),
	conversationId: z.string().optional(),
	runId: z.string().optional(),
	title: z.string(),
	summary: z.string().optional(),
	counts: z.record(z.string(), z.number()).optional(),
	refs: z.record(z.string(), z.array(z.string())).optional(),
	details: RuntimeMetadataSchema.optional(),
	createdAt: z.string().optional(),
});
export type TediCognitiveActivity = z.infer<typeof TediCognitiveActivitySchema>;

// =============================================================================
// CORE OBJECT SCHEMAS
// =============================================================================

export const TediConversationSchema = z.object({
	id: z.string(),
	tediId: z.string(),
	organizationId: z.string().optional(),
	title: z.string().nullable().optional(),
	status: TediConversationStatusSchema,
	channel: z.string().nullable().optional(),
	lastMessageAt: z.string().nullable().optional(),
	messageCount: z.number().int().nonnegative().optional(),
	runtime: TediRuntimeRefSchema.optional(),
	createdAt: z.string(),
	updatedAt: z.string().nullable().optional(),
	/** Pin marker — non-null ISO timestamp when pinned. Sourced from the durable
	 *  kernel conversation index (org-shared), not a per-user overlay. */
	pinnedAt: z.string().nullable().optional(),
	metadata: RuntimeMetadataSchema.optional(),
});
export type TediConversation = z.infer<typeof TediConversationSchema>;

export const TediMessageAttachmentSchema = z.object({
	content: z.string(),
	durationMs: z.number().positive().optional(),
	fileName: z.string(),
	mimeType: z.string(),
	size: z.number().int().nonnegative().optional(),
	type: z.enum(["audio", "file", "image"]),
});
export type TediMessageAttachment = z.infer<typeof TediMessageAttachmentSchema>;

export const TediMessageSchema = z.object({
	id: z.string(),
	tediId: z.string(),
	conversationId: z.string(),
	runId: z.string().optional(),
	role: TediMessageRoleSchema,
	status: TediMessageStatusSchema,
	content: z.string().default(""),
	contentParts: z.array(z.record(z.string(), JsonValueSchema)).optional(),
	attachments: z.array(TediMessageAttachmentSchema).optional(),
	parentMessageId: z.string().nullable().optional(),
	toolCallIds: z.array(z.string()).optional(),
	artifactIds: z.array(z.string()).optional(),
	runtime: TediRuntimeRefSchema.optional(),
	createdAt: z.string(),
	/**
	 * ISO-8601 timestamp marking when the runtime first began producing this
	 * message. For assistant messages, this is the first `message.delta` event
	 * (or `message.received` for user turns). Optional so existing callers and
	 * historical ledger rows that pre-date timing capture continue to parse.
	 * Paired with `completedAt`, it lets every operator client render elapsed
	 * work consistently across live streams and hydrated history.
	 */
	startedAt: z.string().nullable().optional(),
	completedAt: z.string().nullable().optional(),
	metadata: RuntimeMetadataSchema.optional(),
});
export type TediMessage = z.infer<typeof TediMessageSchema>;

const ReplayCheckpointFingerprintSchema = z
	.string()
	.regex(/^sha256:[a-f0-9]{64}$/);

const ReplayCheckpointRefSchema = z.object({
	id: z.string().min(1).max(500),
	revision: z
		.string()
		.min(1)
		.max(500)
		.optional()
		.describe(
			"Optional because some canonical resources do not expose version identifiers.",
		),
	fingerprint: ReplayCheckpointFingerprintSchema,
});

/**
 * Immutable references needed to explain and reconstruct compacted context.
 * These are evidence, not authority: replay consumers must revalidate every
 * capability and approval against its canonical owner before acting.
 */
export const TediConversationReplayCheckpointSchema = z.object({
	version: z.literal(1),
	coveredThroughEntryId: z.string().min(1),
	capabilityBindings: z
		.array(
			ReplayCheckpointRefSchema.extend({
				namespace: z.string().min(1).max(300),
			}),
		)
		.max(100),
	artifactRevisions: z.array(ReplayCheckpointRefSchema).max(100),
	pendingApprovals: z
		.array(
			ReplayCheckpointRefSchema.extend({
				status: z.literal("pending"),
			}),
		)
		.max(100),
	workReferences: z
		.array(
			ReplayCheckpointRefSchema.extend({
				kind: z.enum(["work_item", "home_run", "runtime_run"]),
			}),
		)
		.max(100),
	toolResultDependencies: z
		.array(
			ReplayCheckpointRefSchema.extend({
				toolCallId: z.string().min(1).max(500),
			}),
		)
		.max(100),
	contextSources: z
		.array(
			ReplayCheckpointRefSchema.extend({
				kind: z.string().min(1).max(100),
			}),
		)
		.max(200),
	truncated: z.boolean().default(false),
	checkpointDigest: ReplayCheckpointFingerprintSchema,
});
export type TediConversationReplayCheckpoint = z.infer<
	typeof TediConversationReplayCheckpointSchema
>;

/**
 * Latest durable session-compaction marker projected alongside a conversation
 * transcript. The summary describes the history before `firstKeptEntryId`;
 * message rows remain the full canonical ledger transcript.
 */
export const TediConversationCompactionSchema = z.object({
	summary: z.string(),
	firstKeptEntryId: z.string(),
	tokensBefore: z.number().int().nonnegative(),
	createdAt: z.string(),
	checkpoint: TediConversationReplayCheckpointSchema.optional().describe(
		"Absent on historical compactions created before replay checkpoints were recorded.",
	),
});
export type TediConversationCompaction = z.infer<
	typeof TediConversationCompactionSchema
>;

export const TediRunSchema = z.object({
	id: z.string(),
	tediId: z.string(),
	conversationId: z.string(),
	status: TediRunStatusSchema,
	inputMessageId: z.string().optional(),
	outputMessageId: z.string().nullable().optional(),
	activeToolCallId: z.string().nullable().optional(),
	requiredApprovalIds: z.array(z.string()).optional(),
	error: z
		.object({
			code: z.string().optional(),
			message: z.string(),
			details: RuntimeMetadataSchema.optional(),
		})
		.nullable()
		.optional(),
	runtime: TediRuntimeRefSchema.optional(),
	startedAt: z.string().nullable().optional(),
	completedAt: z.string().nullable().optional(),
	createdAt: z.string(),
	updatedAt: z.string().nullable().optional(),
	metadata: RuntimeMetadataSchema.optional(),
});
export type TediRun = z.infer<typeof TediRunSchema>;

export const TediRuntimeEventSchema = z.object({
	id: z.string(),
	tediId: z.string(),
	kind: TediRuntimeEventKindSchema,
	conversationId: z.string().optional(),
	runId: z.string().optional(),
	messageId: z.string().optional(),
	toolCallId: z.string().optional(),
	approvalRequestId: z.string().optional(),
	artifactId: z.string().optional(),
	sequence: z.number().int().nonnegative().optional(),
	delta: z.string().optional(),
	payload: RuntimeMetadataSchema.optional(),
	/**
	 * Canonical, body-neutral per-turn token usage — promoted out of the raw
	 * `payload` JSON bag so usage is a typed, queryable field every runtime
	 * backend reports the same way. Optional because not every event kind carries
	 * usage (only the turn-terminal / step events do) and because the underlying
	 * provider may not report counts (the null-absent invariant of
	 * {@link BodyExecutionUsageSchema}). Surfaced from `payload.usage` on read so
	 * no storage migration is required.
	 */
	usage: BodyExecutionUsageSchema.optional(),
	runtime: TediRuntimeRefSchema.optional(),
	createdAt: z.string(),
});
export type TediRuntimeEvent = z.infer<typeof TediRuntimeEventSchema>;

export const TediRuntimeCanonicalStatusSchema = z.object({
	health: TediRuntimeHealthSchema,
	activeConversationId: z.string().nullable().optional(),
	activeRunId: z.string().nullable().optional(),
	activeRunStatus: TediRunStatusSchema.nullable().optional(),
	lastActivityAt: z.string().nullable().optional(),
	lastHeartbeatAt: z.string().nullable().optional(),
	startedAt: z.string().nullable().optional(),
	checkedAt: z.string(),
});
export type TediRuntimeCanonicalStatus = z.infer<
	typeof TediRuntimeCanonicalStatusSchema
>;

export const TediRuntimeBackendDiagnosticsSchema = z.object({
	backend: TediRuntimeBackendSchema,
	kind: TediRuntimeBackendDiagnosticsKindSchema.default("unknown"),
	health: TediRuntimeHealthSchema.optional(),
	state: z.string().nullable().optional(),
	statusDetail: z.string().nullable().optional(),
	connectionId: z.string().nullable().optional(),
	version: z.string().nullable().optional(),
	readiness: RuntimeMetadataSchema.optional(),
	processSummary: RuntimeMetadataSchema.optional(),
	processTracking: RuntimeMetadataSchema.optional(),
	metadata: RuntimeMetadataSchema.optional(),
	raw: z.unknown().optional(),
	checkedAt: z.string().optional(),
	livenessVerdict: TediLivenessVerdictSchema.optional(),
});
export type TediRuntimeBackendDiagnostics = z.infer<
	typeof TediRuntimeBackendDiagnosticsSchema
>;

export const TediRuntimeStatusSchema = z.object({
	tediId: z.string(),
	backend: TediRuntimeBackendSchema,
	health: TediRuntimeHealthSchema,
	canonical: TediRuntimeCanonicalStatusSchema.optional(),
	activeConversationId: z.string().nullable().optional(),
	activeRunId: z.string().nullable().optional(),
	activeRunStatus: TediRunStatusSchema.nullable().optional(),
	lastActivityAt: z.string().nullable().optional(),
	lastHeartbeatAt: z.string().nullable().optional(),
	startedAt: z.string().nullable().optional(),
	version: z.string().nullable().optional(),
	backendDiagnostics: TediRuntimeBackendDiagnosticsSchema.optional(),
	// Adapter diagnostics bag retained until product callers read the explicit
	// `canonical` and `backendDiagnostics` projections directly.
	diagnostics: RuntimeMetadataSchema.optional(),
	checkedAt: z.string(),
	livenessVerdict: TediLivenessVerdictSchema.optional(),
});
export type TediRuntimeStatus = z.infer<typeof TediRuntimeStatusSchema>;

// =============================================================================
// ADAPTER INPUT SCHEMAS
// =============================================================================

export const ConversationListCursorSchema = z.string().refine((value) => {
	const separatorAt = value.indexOf("|");
	return separatorAt > 0 && separatorAt < value.length - 1;
}, "Invalid conversation cursor");

export const ListConversationsInputSchema = z.object({
	tediId: z.string(),
	limit: z.number().int().positive().max(500).optional(),
	cursor: ConversationListCursorSchema.optional(),
	search: z.string().optional(),
	channel: z.string().optional(),
	includeArchived: z.boolean().optional(),
});
export type ListConversationsInput = z.infer<
	typeof ListConversationsInputSchema
>;

export const ReadMessagesInputSchema = z.object({
	tediId: z.string(),
	conversationId: z.string(),
	limit: z.number().int().positive().max(500).optional(),
	cursor: z.string().optional(),
});
export type ReadMessagesInput = z.infer<typeof ReadMessagesInputSchema>;

export const ReadMessagesOutputSchema = z.object({
	messages: z.array(TediMessageSchema),
	compaction: TediConversationCompactionSchema.nullable().describe(
		"Latest valid durable compaction overlay for this conversation, or null before any compaction has been recorded.",
	),
	nextCursor: z
		.string()
		.nullable()
		.optional()
		.describe(
			"Pagination cursor for an older transcript page; absent or null when no older page remains.",
		),
});
export type ReadMessagesOutput = z.infer<typeof ReadMessagesOutputSchema>;

export const EnqueueMessageInputSchema = z.object({
	tediId: z.string(),
	conversationId: z.string().optional(),
	// Empty content is valid for attachment-only sends (voice notes record ""
	// typed text); "content OR attachments" is enforced in the router handler.
	content: z.string(),
	idempotencyKey: z.string().min(1),
	deliver: z.boolean().optional(),
	attachments: z.array(TediMessageAttachmentSchema).optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
	sessionId: z.string().optional(),
});
export type EnqueueMessageInput = z.infer<typeof EnqueueMessageInputSchema>;

export const WriteDispatchIdempotencyInputSchema = z.object({
	idempotencyKey: z.string().min(1),
	tediId: z.string().min(1),
	organizationId: z.string().nullable().optional(),
	conversationId: z.string().min(1),
	status: z.enum(["queued", "failed"]).optional(),
});
export type WriteDispatchIdempotencyInput = z.infer<
	typeof WriteDispatchIdempotencyInputSchema
>;

export const PatchDispatchIdempotencyInputSchema = z.object({
	tediId: z.string().min(1),
	conversationId: z.string().min(1),
	runId: z.string().min(1),
	organizationId: z.string().nullable().optional(),
});
export type PatchDispatchIdempotencyInput = z.infer<
	typeof PatchDispatchIdempotencyInputSchema
>;

export const EnqueueMessageOutputSchema = z.object({
	idempotencyKey: z.string(),
	conversationId: z.string(),
	runId: z.string().optional(),
	status: z.enum(["queued", "failed"]),
	error: z.string().optional(),
	/** Machine-readable failure reason when status=failed. Mirrors RunTerminalReason
	 * for the subset of reasons reachable on the enqueue path. */
	reason: z.enum(["dispatch_failed", "runtime_unavailable"]).optional(),
});
export type EnqueueMessageOutput = z.infer<typeof EnqueueMessageOutputSchema>;

export const StreamEventsInputSchema = z.object({
	tediId: z.string(),
	conversationId: z.string().optional(),
	runId: z.string().optional(),
	cursor: z.string().optional(),
});
export type StreamEventsInput = z.infer<typeof StreamEventsInputSchema>;

export const ListApprovalsInputSchema = z.object({
	tediId: z.string(),
	status: TediApprovalStatusSchema.optional(),
	limit: z.number().int().positive().max(500).optional(),
	cursor: z.string().optional(),
});
export type ListApprovalsInput = z.infer<typeof ListApprovalsInputSchema>;

export const StopRunInputSchema = z.object({
	tediId: z.string(),
	runId: z.string(),
	conversationId: z.string().optional(),
	reason: z.string().optional(),
});
export type StopRunInput = z.infer<typeof StopRunInputSchema>;

export type RuntimeEventCursor = { createdAt: string; id: string };

function runtimeEventCursorBytes(value: string): string {
	return String.fromCharCode(...new TextEncoder().encode(value));
}

export function encodeRuntimeEventCursor(cursor: RuntimeEventCursor): string {
	return btoa(
		runtimeEventCursorBytes(JSON.stringify([cursor.createdAt, cursor.id])),
	)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/u, "");
}

export function decodeRuntimeEventCursor(
	value: string,
): RuntimeEventCursor | null {
	try {
		if (value.length > 4_096 || !/^[A-Za-z0-9_-]+$/u.test(value)) return null;
		const padded = value.replaceAll("-", "+").replaceAll("_", "/");
		const json = new TextDecoder("utf-8", {
			fatal: true,
			ignoreBOM: false,
		}).decode(
			Uint8Array.from(
				atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "=")),
				(character) => character.charCodeAt(0),
			),
		);
		const parsed: unknown = JSON.parse(json);
		if (
			!Array.isArray(parsed) ||
			parsed.length !== 2 ||
			typeof parsed[0] !== "string" ||
			!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(parsed[0]) ||
			!Number.isFinite(Date.parse(parsed[0])) ||
			typeof parsed[1] !== "string" ||
			parsed[1].length === 0
		) {
			return null;
		}
		const cursor = { createdAt: parsed[0], id: parsed[1] };
		return encodeRuntimeEventCursor(cursor) === value ? cursor : null;
	} catch {
		return null;
	}
}

export const RuntimeEventCursorSchema = z
	.string()
	.min(1)
	.max(4_096)
	.refine((value) => decodeRuntimeEventCursor(value) !== null, {
		message: "Invalid runtime event cursor",
	});

export const ApproveInputSchema = z.object({
	tediId: z.string(),
	approvalRequestId: z.string(),
	approved: z.boolean(),
	resolution: z.string().optional(),
	metadata: RuntimeMetadataSchema.optional(),
});
export type ApproveInput = z.infer<typeof ApproveInputSchema>;

export const GetRuntimeStatusInputSchema = z.object({
	tediId: z.string(),
});
export type GetRuntimeStatusInput = z.infer<typeof GetRuntimeStatusInputSchema>;

export const ListRuntimeEventsInputSchema = z.object({
	tediId: z.string(),
	conversationId: z.string().optional(),
	runId: z.string().optional(),
	kind: TediRuntimeEventKindSchema.optional(),
	limit: z.number().int().positive().max(500).optional(),
	/**
	 * Pagination cursor for DESC-paginate-into-older walks. Returns events
	 * before the cursor's `(createdAt, id)` tuple. The field is named `before` (not the
	 * direction-ambiguous `cursor`) so callers cannot accidentally interpret
	 * it as "events newer than X". Pass the `nextBefore` value from the
	 * previous page to fetch the next older page.
	 */
	before: RuntimeEventCursorSchema.optional(),
	/**
	 * Compact projection for agent context budgets: drops the `payload` JSON bag
	 * and truncates `delta` to a short preview while keeping ids, kinds, usage,
	 * and timestamps — the bulk a scanning agent rarely needs. Fetch the full event by re-reading without
	 * `summary` once you know WHICH event you care about.
	 */
	summary: z.boolean().optional(),
});
export type ListRuntimeEventsInput = z.infer<
	typeof ListRuntimeEventsInputSchema
>;

export const RecordRuntimeEventInputSchema = TediRuntimeEventSchema.omit({
	id: true,
	createdAt: true,
}).extend({
	id: z.string().optional(),
	createdAt: z.string().optional(),
});
export type RecordRuntimeEventInput = z.infer<
	typeof RecordRuntimeEventInputSchema
>;

export const ListArtifactsInputSchema = z.object({
	tediId: z.string(),
	conversationId: z.string().optional(),
	runId: z.string().optional(),
	messageId: z.string().optional(),
	kind: TediArtifactKindSchema.optional(),
	name: z
		.string()
		.optional()
		.describe(
			"Optional exact recorded artifact name filter, e.g. workstation_process/<id>/stdout.log; omission lists every artifact in scope.",
		),
	limit: z.number().int().positive().max(500).optional(),
	cursor: z.string().optional(),
});
export type ListArtifactsInput = z.infer<typeof ListArtifactsInputSchema>;

export const RecordArtifactInputSchema = TediArtifactSchema.omit({
	id: true,
	createdAt: true,
}).extend({
	id: z.string().optional(),
	createdAt: z.string().optional(),
	/**
	 * Inline body to publish. When set, the server writes it to R2 (the tedi
	 * deliverable bucket) and derives `uri`/`sizeBytes` itself — making this a
	 * complete "publish deliverable" call so any caller (skill, tedi, cron) can
	 * produce an openable artifact in one shot, not just register a row.
	 */
	content: z.string().optional(),
	/**
	 * Encoding of `content`. `"utf8"` (default) writes the string as-is — for
	 * text formats (HTML, Markdown, JSON, CSV). `"base64"` decodes to raw bytes
	 * first — for binary formats (PDF, PNG, etc). Pair with an accurate
	 * `mimeType` (e.g. `application/pdf`) so the artifact serves correctly.
	 */
	contentEncoding: z.enum(["utf8", "base64"]).optional(),
	/**
	 * Bundle mode: publish a multi-file deliverable (an interactive dashboard,
	 * a small static site) instead of a single body. Mutually exclusive with
	 * `content`. Each file lands under the artifact's R2 prefix and is served
	 * at `GET /artifacts[/s]/:tediId/:artifactId/<path>`; the bare artifact URL
	 * serves `entrypoint` (default `index.html`). Reusing an artifact id is an
	 * exact replay only; changed bytes require a new artifact revision/id.
	 */
	files: z
		.array(
			z.object({
				path: z
					.string()
					.min(1)
					.max(512)
					.describe("Bundle-relative path, e.g. index.html or js/app.js"),
				content: z.string(),
				contentEncoding: z.enum(["utf8", "base64"]).optional(),
				mimeType: z.string().optional(),
			}),
		)
		.min(1)
		.max(100)
		.optional(),
	/** Bundle entry file served at the bare artifact URL. Default index.html. */
	entrypoint: z.string().optional(),
});
export type RecordArtifactInput = z.infer<typeof RecordArtifactInputSchema>;

export const GetArtifactInputSchema = z.object({
	tediId: z.string(),
	artifactId: z.string(),
});
export type GetArtifactInput = z.infer<typeof GetArtifactInputSchema>;

export const CreateArtifactShareLinkInputSchema = z.object({
	tediId: z.string(),
	artifactId: z.string(),
	/** Link lifetime; defaults to 1h, capped at 7d server-side. */
	ttlSeconds: z.number().int().positive().optional(),
});
export type CreateArtifactShareLinkInput = z.infer<
	typeof CreateArtifactShareLinkInputSchema
>;

export const CreateArtifactShareLinkOutputSchema = z.object({
	url: z.string(),
	expiresAt: z.string(),
	artifactId: z.string(),
});
export type CreateArtifactShareLinkOutput = z.infer<
	typeof CreateArtifactShareLinkOutputSchema
>;

export const ArtifactReleaseSourceStatusSchema = z.enum([
	"unknown_history",
	"known_current",
	"known_unverifiable",
	"unavailable",
]);

export const ArtifactReleasePreviewSchema = z.object({
	artifactId: z.string(),
	digest: z.string().regex(/^[a-f0-9]{64}$/),
	text: z.string().max(50 * 1024),
	mimeType: z.literal("text/plain; charset=utf-8"),
});

export const ArtifactReleaseReviewSchema = z.object({
	candidateId: z.string(),
	parentArtifactId: z.string(),
	parentContentDigest: z.string().regex(/^[a-f0-9]{64}$/),
	childArtifactId: z.string(),
	childContentDigest: z.string().regex(/^[a-f0-9]{64}$/),
	sourceStatus: ArtifactReleaseSourceStatusSchema,
	sourceNotice: z.string(),
	reviewability: z.enum(["reviewable", "unavailable"]),
	reviewHeadId: z.string(),
	activeApprovalId: z
		.string()
		.nullable()
		.describe("Null until approval or after the active approval is revoked."),
	recordedApprovalId: z
		.string()
		.nullable()
		.describe(
			"The current recorded approval head, retained for revocation even when its reviewer is no longer an active owner.",
		),
	releaseActive: z.boolean(),
	createdAt: z.string(),
	parentPreview: ArtifactReleasePreviewSchema.nullable().describe(
		"Null when the original private body is unavailable; revocation remains allowed.",
	),
	candidatePreview: ArtifactReleasePreviewSchema.nullable().describe(
		"Null when exact private bytes or current source checks are unavailable; revocation metadata remains visible.",
	),
});
export type ArtifactReleaseReview = z.infer<typeof ArtifactReleaseReviewSchema>;
export const ArtifactReleaseSourcePreviewSchema = z.object({
	parentArtifactId: z.string(),
	parentContentDigest: z.string().regex(/^[a-f0-9]{64}$/),
	sourceStatus: ArtifactReleaseSourceStatusSchema,
	sourceNotice: z.string(),
	parentPreview: ArtifactReleasePreviewSchema,
});
export type ArtifactReleaseSourcePreview = z.infer<
	typeof ArtifactReleaseSourcePreviewSchema
>;

export const CreateRedactedArtifactRevisionInputSchema = z.object({
	tediId: z.string().min(1),
	parentArtifactId: z.string().min(1),
	expectedParentDigest: z.string().regex(/^[a-f0-9]{64}$/),
	content: z
		.string()
		.min(1)
		.max(50 * 1024),
	idempotencyKey: z.string().min(1).max(200),
});
export const GetArtifactReleaseReviewInputSchema = z
	.object({
		tediId: z.string().min(1),
		candidateId: z
			.string()
			.min(1)
			.optional()
			.describe(
				"Existing immutable candidate target; mutually exclusive with sourceArtifactId.",
			),
		sourceArtifactId: z
			.string()
			.min(1)
			.optional()
			.describe(
				"Original private artifact target; mutually exclusive with candidateId.",
			),
	})
	.refine(
		(value) =>
			Number(Boolean(value.candidateId)) +
				Number(Boolean(value.sourceArtifactId)) ===
			1,
		{
			message: "Exactly one artifact release review target is required",
		},
	);
const ArtifactReleaseCandidateTargetSchema = z.object({
	tediId: z.string().min(1),
	candidateId: z.string().min(1),
});
export const ApproveArtifactReleaseInputSchema =
	ArtifactReleaseCandidateTargetSchema.extend({
		expectedReviewHeadId: z.string().min(1),
		childContentDigest: z.string().regex(/^[a-f0-9]{64}$/),
		acknowledgeIncompleteSourceHistory: z.literal(true),
		attestation: z.string().trim().min(1).max(1000),
	});
export const RevokeArtifactReleaseInputSchema =
	ArtifactReleaseCandidateTargetSchema.extend({
		expectedApprovalId: z.string().min(1),
		childContentDigest: z.string().regex(/^[a-f0-9]{64}$/),
		reason: z.string().trim().min(1).max(1000),
	});
export const ArtifactReleaseDecisionOutputSchema = z.object({
	review: ArtifactReleaseReviewSchema.nullable().describe(
		"Null after a revocation when private preview bytes are unavailable.",
	),
	decision: z.object({
		reviewId: z.string(),
		eventType: z.enum(["approved", "revoked"]),
		candidateId: z.string(),
		childContentDigest: z.string().regex(/^[a-f0-9]{64}$/),
	}),
});

export const GetRuntimeStabilityInputSchema = z.object({
	tediId: z.string(),
});
export type GetRuntimeStabilityInput = z.infer<
	typeof GetRuntimeStabilityInputSchema
>;

/**
 * Runtime stability diagnostics. Fields are runtime-neutral wrappers around
 * backend-specific health probes.
 * `raw` carries the unfiltered backend payload for adapters that need it; new
 * consumers should read the canonical surface on top.
 */
export const TediRuntimeStabilitySchema = z.object({
	tediId: z.string(),
	backend: TediRuntimeBackendSchema,
	checkedAt: z.string(),
	eventLoop: z
		.object({
			delayMaxMs: z.number().optional(),
			delayP99Ms: z.number().optional(),
			elu: z.number().optional(),
		})
		.passthrough()
		.optional(),
	pluginHooks: z.unknown().optional(),
	startup: z.unknown().optional(),
	tasks: z.unknown().optional(),
	raw: z.unknown().optional(),
});
export type TediRuntimeStability = z.infer<typeof TediRuntimeStabilitySchema>;

export interface TediRuntimeAdapter {
	listConversations(input: ListConversationsInput): Promise<TediConversation[]>;
	readMessages(input: ReadMessagesInput): Promise<TediMessage[]>;
	enqueueMessage?(input: EnqueueMessageInput): Promise<EnqueueMessageOutput>;
	streamEvents(input: StreamEventsInput): AsyncIterable<TediRuntimeEvent>;
	stopRun(input: StopRunInput): Promise<void>;
	approve(input: ApproveInput): Promise<void>;
	getStatus(input: GetRuntimeStatusInput): Promise<TediRuntimeStatus>;
	// Note: listApprovals intentionally lives on the API router, not the adapter.
	// Approvals are Tedix-canonical durable state read from tedi_approval_requests,
	// not adapter-canonical runtime state.
}

// ─────────────────────────────────────────────────────────────────────────────
// Run terminal state machine
//
// The single named source of truth for the commit/ack invariant: **every
// `run.started` lands EXACTLY ONE terminal event** (`run.completed | run.failed
// | run.canceled`). The terminal is written by one of three converging paths,
// and the `(tediId, runId, kind)` insert-boundary dedup in apps/api
// `insertRuntimeEvent` admits exactly one regardless of which fires:
//
//   - `isolate_body`  — apps/tedi-runtime AgentTediDO seals synchronously:
//     onChatResponse (`run.completed`), onChatError / onChatResponse(status≠
//     "completed") (`run.failed`), and chatRecovery.onExhausted (`run.failed`
//     with a bounded recovery budget). See docs/engineering/tedi/agent-runtime.md.
//   - `api_dispatch`  — apps/api cognitiveRuntime.enqueueMessage writes
//     `run.failed` when the runtime cannot be reached to start the turn.
//   - `orphan_sweep`  — apps/api sweepOrphanRuns (scheduled every 2 min; a
//     12-minute age + multi-kind liveness predicate decides candidacy)
//     synthesizes `run.completed` when durable success evidence exists but the
//     terminal was lost, otherwise `run.failed` with `runtime_dropped`. See
//     docs/engineering/cognition/runtime.md "Canonical orphan-run health".
//
// Terminal `run.failed` carries `payload.reason: RunTerminalReason` when the
// cause fits an existing category; known observation failures omit it instead of
// blaming the model. The raw error remains available. Where the writer supports
// it, `runtimeMetadata.source: RunTerminalSource` identifies the sealing path.
// ─────────────────────────────────────────────────────────────────────────────

/** The terminal kinds a run can seal to. */
export const RUN_TERMINAL_KINDS = [
	"run.completed",
	"run.failed",
	"run.canceled",
] as const;
export type RunTerminalKind = (typeof RUN_TERMINAL_KINDS)[number];

/**
 * Canonical machine-readable reason a run sealed to a non-success terminal.
 * `run.completed` carries no reason. Keep this the only place these strings are
 * defined; terminal writers must reference these keys, not ad-hoc literals.
 */
export const RUN_TERMINAL_REASONS = {
	recovery_exhausted:
		"Durable chat recovery exhausted its budget (Think onExhausted).",
	llm_error: "The model/provider call errored.",
	empty_message: "The model produced no assistant content.",
	dispatch_failed: "The runtime could not be reached to start the turn.",
	runtime_unavailable:
		"Preflight check determined the runtime is unreachable or stopped; dispatch was never attempted.",
	runtime_dropped:
		"The runtime started the turn but never published a terminal; sealed by the scheduled orphan sweep.",
	canceled_by_user: "A caller stopped or canceled the run.",
} as const;
export type RunTerminalReason = keyof typeof RUN_TERMINAL_REASONS;

/**
 * Classify a failed turn's machine-readable {@link RunTerminalReason} from the
 * terminal error text. Timeouts, runtime resets, tool errors, and model errors
 * retain their own categories even when no assistant prose was emitted.
 * `empty_message` identifies the empty-assistant sentinel without another
 * error; `payload.error` retains the raw diagnostic text. A known
 * workstation observation failure has no truthful category in the existing
 * vocabulary: return undefined so the writer omits reason and retains error.
 */
export function classifyRunTerminalReason(input: {
	/** Raw terminal error text (the `payload.error` string). */
	error: string;
	/** Whether the turn produced any trimmed assistant prose. */
	hasAssistantContent: boolean;
	/** True when the failure is a durable-recovery exhaustion. */
	recovery?: boolean;
}): RunTerminalReason | undefined {
	if (input.recovery) return "recovery_exhausted";
	// Exact current producer envelope (workstation status → workflow continuation
	// → terminal mirror). Only its real diagnostics delimiter may extend it;
	// diagnostic text does not establish a model, runtime-reset, or empty cause.
	const observationUnavailable =
		"workflow errored before terminal: Computer execution status read failed: workstation job observation unavailable";
	if (
		input.error === observationUnavailable ||
		input.error.startsWith(`${observationUnavailable}; diagnostics=`)
	) {
		return undefined;
	}
	const e = input.error.toLowerCase();
	// Genuine no-content turn: the model produced nothing and the only signal is
	// the empty-assistant sentinel (never a masked real error).
	if (!input.hasAssistantContent && /empty_(?:assistant_)?message/.test(e)) {
		return "empty_message";
	}
	// The DO hosting the turn was retired mid-flight (deploy code-update reset,
	// isolate OOM, internal storage reset) — a runtime loss, not a turn failure.
	if (
		/reset because its code was updated|reset.*code update|exceeded (?:its )?memory limit|out of memory|durable object.*reset|storage.*reset/.test(
			e,
		)
	) {
		return "runtime_dropped";
	}
	// A real terminal error (timeout, fail-soft tool failure, model/provider or
	// stream error), with or without partial prose. The raw text stays in
	// `payload.error`; the category is honest instead of a false empty_message.
	return "llm_error";
}

/** Which code path sealed the run (observability — see the writer list above). */
export const RUN_TERMINAL_SOURCES = {
	isolate_body: "apps/tedi-runtime AgentTediDO",
	api_dispatch:
		"apps/api cognitiveRuntime.enqueueMessage dispatch-failure catch",
	orphan_sweep: "apps/api sweepOrphanRuns (scheduled)",
	runtime_resident: "resident runtime path",
} as const;
export type RunTerminalSource = keyof typeof RUN_TERMINAL_SOURCES;
