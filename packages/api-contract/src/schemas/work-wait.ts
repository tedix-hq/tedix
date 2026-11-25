import * as z from "zod";

/** Continuation positions belong to one Work Item; callers must preserve them. */
export const WorkItemWaitCursorSchema = z.strictObject({
	workItemId: z.uuid(),
	event: z.number().int().nonnegative(),
	message: z.number().int().nonnegative(),
	response: z.number().int().nonnegative(),
	interaction: z
		.strictObject({
			id: z.uuid(),
			version: z.number().int().positive(),
			state: z.string(),
		})
		.nullable()
		.optional(),
});

export const InteractionWaitCursorSchema = z.strictObject({
	interactionId: z.uuid(),
	version: z.number().int().positive(),
	state: z.string(),
	draftId: z.uuid().nullable(),
});

export const WorkWaitCursorSchema = z.union([
	WorkItemWaitCursorSchema,
	InteractionWaitCursorSchema,
]);

export const WorkWaitInputSchema = z
	.strictObject({
		id: z.uuid().optional(),
		interactionId: z.uuid().optional(),
		cursor: WorkWaitCursorSchema.optional(),
		timeoutMs: z.number().int().min(0).max(25_000).default(20_000),
	})
	.refine(
		(input) => input.id || input.interactionId,
		"A Work Item or Interaction is required",
	);

export const WorkWaitResultSchema = z.strictObject({
	reason: z.enum(["changed", "timeout"]),
	cursor: WorkWaitCursorSchema,
	changes: z.array(
		z.strictObject({
			kind: z.enum(["event", "message", "response"]),
			id: z.string(),
			type: z.string(),
		}),
	),
});
