/**
 * Run log and steering for a Work Item Attempt: the steps a run reports while
 * it works, and the follow-ups or stop a person or tedi sends to it.
 */

import * as z from "zod";

/**
 * The one machine scope that reads a run's steps and steers the run and nothing
 * else. The tedi runtime delegates it over its trusted service binding for the
 * calling tedi, so its agent-run tools work without the wider `mcp:work.read`
 * and `mcp:work.write`. A follow-up or a stop still needs the Work Item's
 * owner or steward.
 */
export const WORK_RUN_STEER_SCOPE = "work:steer";

export const WorkAttemptStepKindSchema = z.enum([
	"started",
	"message",
	"command",
	"tool",
	"file_change",
	"error",
	"follow_up",
	"stopped",
	"finished",
]);
export type WorkAttemptStepKind = z.infer<typeof WorkAttemptStepKindSchema>;

export const WorkAttemptStepSchema = z.object({
	seq: z
		.number()
		.int()
		.nonnegative()
		.describe(
			"Position of the step in its run. The runner counts up from its first step; a step whose seq is already stored is ignored.",
		),
	at: z
		.number()
		.int()
		.nonnegative()
		.describe("When the step happened, in milliseconds since 1 January 1970."),
	kind: WorkAttemptStepKindSchema,
	text: z
		.string()
		.max(500)
		.describe("Short summary of the step. Never tool output or file contents."),
});
export type WorkAttemptStep = z.infer<typeof WorkAttemptStepSchema>;

export const WorkAttemptMessageKindSchema = z.enum(["follow_up", "stop"]);
export type WorkAttemptMessageKind = z.infer<
	typeof WorkAttemptMessageKindSchema
>;

export const WorkAttemptMessageSenderTypeSchema = z.enum([
	"user",
	"tedi",
	"external_agent",
]);

/** A message as the runner receives it with its step report. */
export const WorkAttemptPendingMessageSchema = z.object({
	id: z.uuid(),
	kind: WorkAttemptMessageKindSchema,
	body: z.string().max(4_000),
	senderType: WorkAttemptMessageSenderTypeSchema,
	senderId: z.string().min(1).max(300),
	createdAt: z.iso.datetime(),
});
export type WorkAttemptPendingMessage = z.infer<
	typeof WorkAttemptPendingMessageSchema
>;

export const WorkAttemptMessageSchema = WorkAttemptPendingMessageSchema.extend({
	deliveredAt: z.iso
		.datetime()
		.nullable()
		.describe("When the runner received the message; null while it waits."),
	appliedAt: z.iso
		.datetime()
		.nullable()
		.describe("When the runner acted on the message; null until then."),
});
export type WorkAttemptMessage = z.infer<typeof WorkAttemptMessageSchema>;

export const AppendWorkAttemptStepsInputSchema = z.strictObject({
	id: z.uuid(),
	attemptId: z.uuid(),
	steps: z
		.array(WorkAttemptStepSchema)
		.max(50)
		.describe(
			"New steps of this run, oldest first. May be empty to only collect waiting messages.",
		),
	appliedMessageIds: z
		.array(z.uuid())
		.max(50)
		.optional()
		.describe("Messages the runner has acted on since its last report."),
});

export const AppendWorkAttemptStepsResultSchema = z.object({
	accepted: z
		.number()
		.int()
		.nonnegative()
		.describe("How many of the sent steps were new and stored."),
	pending: z
		.array(WorkAttemptPendingMessageSchema)
		.describe(
			"Messages this run has not yet reported in appliedMessageIds, oldest first. A message is returned again until then, so tell them apart by id.",
		),
});

export const ListWorkAttemptStepsInputSchema = z.strictObject({
	id: z.uuid(),
	attemptId: z
		.uuid()
		.optional()
		.describe("Omit to read the newest run of the Work Item."),
	afterSeq: z.coerce
		.number()
		.int()
		.nonnegative()
		.optional()
		.describe("Return only steps after this seq."),
	limit: z.coerce.number().int().min(1).max(500).optional().default(200),
});

export const ListWorkAttemptStepsResultSchema = z.object({
	attemptId: z
		.uuid()
		.nullable()
		.describe("The run these steps belong to; null when none has started."),
	live: z
		.boolean()
		.describe(
			"True while the run has no outcome and its lease has not expired. Only a live run takes a follow-up or a stop.",
		),
	steps: z.array(WorkAttemptStepSchema),
	messages: z.array(WorkAttemptMessageSchema),
});
export type ListWorkAttemptStepsResult = z.infer<
	typeof ListWorkAttemptStepsResultSchema
>;

export const SendWorkAttemptMessageInputSchema = z.strictObject({
	id: z.uuid(),
	body: z
		.string()
		.trim()
		.min(1)
		.max(4_000)
		.describe(
			"The follow-up for the agent. It is applied after the agent's current turn ends.",
		),
});

export const StopWorkAttemptInputSchema = z.strictObject({ id: z.uuid() });
