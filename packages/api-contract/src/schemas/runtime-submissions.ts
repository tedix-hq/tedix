/**
 * Runtime submission + durable stream contract schemas.
 *
 * Tedix-native, body-neutral shapes for the durable submission/attempt lifecycle
 * and the offset-based stream-read envelope. The canonical ledger is Tedix D1.
 */

import * as z from "zod";
import { JsonValueSchema } from "./common";

export const RuntimeSubmissionSubjectKindSchema = z.enum(["kernel", "tedi"]);
export type RuntimeSubmissionSubjectKind = z.infer<
	typeof RuntimeSubmissionSubjectKindSchema
>;

export const RuntimeSubmissionSourceKindSchema = z.enum([
	"home",
	"tedi_message",
	"skill_workflow",
	"workflow",
	"system",
]);
export type RuntimeSubmissionSourceKind = z.infer<
	typeof RuntimeSubmissionSourceKindSchema
>;

export const RuntimeSubmissionStatusSchema = z.enum([
	"admitted",
	"running",
	// Non-terminal latch for the crash-safe two-step settle (reserve -> finalize);
	// must be accepted here or any RPC returning a reserved row fails Zod parse.
	"reserved",
	"settled",
	"failed",
	"canceled",
]);
export type RuntimeSubmissionStatus = z.infer<
	typeof RuntimeSubmissionStatusSchema
>;

export const RuntimeSubmissionAttemptStatusSchema = z.enum([
	"started",
	"recovered",
	"settled",
	"failed",
	"canceled",
]);
export type RuntimeSubmissionAttemptStatus = z.infer<
	typeof RuntimeSubmissionAttemptStatusSchema
>;

export const RuntimeSubmissionSchema = z.object({
	id: z.string(),
	organizationId: z.string(),
	subjectKind: RuntimeSubmissionSubjectKindSchema,
	subjectId: z.string(),
	tediId: z.string().nullable().optional(),
	conversationId: z.string().nullable().optional(),
	runId: z.string().nullable().optional(),
	idempotencyKey: z.string().nullable().optional(),
	sourceKind: RuntimeSubmissionSourceKindSchema,
	sourceProvider: z.string().nullable().optional(),
	sourceDeliveryId: z.string().nullable().optional(),
	status: RuntimeSubmissionStatusSchema,
	currentAttemptId: z.string().nullable().optional(),
	attemptCount: z.number().int().nonnegative(),
	runtimeBackend: z.string().nullable().optional(),
	metadata: z.record(z.string(), JsonValueSchema).nullable().optional(),
	createdAt: z.string(),
	updatedAt: z.string(),
	settledAt: z.string().nullable().optional(),
});
export type RuntimeSubmission = z.infer<typeof RuntimeSubmissionSchema>;

export const RuntimeSubmissionAttemptSchema = z.object({
	id: z.string(),
	submissionId: z.string(),
	organizationId: z.string(),
	attemptNo: z.number().int().positive(),
	status: RuntimeSubmissionAttemptStatusSchema,
	runtimeBackend: z.string().nullable().optional(),
	runtimeExternalId: z.string().nullable().optional(),
	error: z.string().nullable().optional(),
	metadata: z.record(z.string(), JsonValueSchema).nullable().optional(),
	startedAt: z.string(),
	heartbeatAt: z.string().nullable().optional(),
	completedAt: z.string().nullable().optional(),
});
export type RuntimeSubmissionAttempt = z.infer<
	typeof RuntimeSubmissionAttemptSchema
>;

// =============================================================================
// DURABLE STREAM READ (Phase 3 scaffold)
// =============================================================================

/** Body-neutral runtime-event projection returned by a durable stream read. */
export const RuntimeStreamEventSchema = z.object({
	id: z.string(),
	kind: z.string(),
	conversationId: z.string().nullable().optional(),
	runId: z.string().nullable().optional(),
	messageId: z.string().nullable().optional(),
	causeEventId: z
		.string()
		.min(1)
		.nullable()
		.optional()
		.describe(
			"Absent or null for legacy events and events without an explicitly recorded cause; never inferred during replay.",
		),
	toolCallId: z.string().nullable().optional(),
	approvalRequestId: z.string().nullable().optional(),
	artifactId: z.string().nullable().optional(),
	sequence: z.number().int().nullable().optional(),
	delta: z.string().nullable().optional(),
	payload: z.record(z.string(), JsonValueSchema).nullable().optional(),
	createdAt: z.string(),
});
export type RuntimeStreamEvent = z.infer<typeof RuntimeStreamEventSchema>;

/** Cursor a caller uses to resume a durable run stream from where it left off. */
export const RuntimeStreamReceiptSchema = z.object({
	streamId: z.string(),
	offset: z.number().int().nonnegative(),
	nextOffset: z.number().int().nonnegative(),
	closed: z.boolean(),
	terminalEventId: z.string().nullable().optional(),
	submissionId: z.string().nullable().optional(),
});
export type RuntimeStreamReceipt = z.infer<typeof RuntimeStreamReceiptSchema>;

export const RuntimeStreamReadInputSchema = z.object({
	runId: z.string(),
	organizationId: z.string().optional(),
	offset: z.number().int().nonnegative().optional(),
	tail: z.number().int().positive().optional(),
	limit: z
		.number()
		.int()
		.positive()
		.optional()
		.describe(
			"Optional for compatibility: absent means the server page size, which is what every reader predating bounded paging asks for.",
		),
	waitMs: z.number().int().min(0).max(30000).optional(),
});
export type RuntimeStreamReadInput = z.infer<
	typeof RuntimeStreamReadInputSchema
>;

export const RuntimeStreamReadOutputSchema = z.object({
	events: z.array(RuntimeStreamEventSchema),
	stream: RuntimeStreamReceiptSchema,
});
export type RuntimeStreamReadOutput = z.infer<
	typeof RuntimeStreamReadOutputSchema
>;
