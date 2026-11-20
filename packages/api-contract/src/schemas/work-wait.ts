import * as z from "zod";

/** Continuation positions belong to one Work Item; callers must preserve them. */
export const WorkWaitCursorSchema = z.strictObject({
	workItemId: z.uuid(),
	event: z.number().int().nonnegative(),
	message: z.number().int().nonnegative(),
	response: z.number().int().nonnegative(),
});

export const WorkWaitInputSchema = z.strictObject({
	id: z.uuid(),
	cursor: WorkWaitCursorSchema.optional(),
	timeoutMs: z.number().int().min(0).max(25_000).default(20_000),
});

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
