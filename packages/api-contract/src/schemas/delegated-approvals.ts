import { z } from "zod";

/** An organization opt-in; absence grants no standing delegation. */
export const DelegatedApprovalsPolicySchema = z.strictObject({
	enabled: z.boolean(),
	/** Owner user id -> designated external-agent principal id. */
	leadAgents: z.record(z.string().min(1), z.uuid()).default({}),
});

export const DelegatedApprovalReceiptSchema = z.strictObject({
	ownerId: z.string().min(1),
	actorType: z.enum(["tedi", "external_agent"]),
	actorId: z.string().min(1),
	actorName: z.string().min(1),
	reason: z.string().min(1),
});

export const DecidedForYouItemSchema = z.object({
	id: z.string(),
	source: z.enum(["interaction", "runtime"]),
	requestId: z.string(),
	subject: z.string(),
	decision: z.string(),
	decidedAt: z.string(),
	undoneAt: z.string().nullable().optional(),
	workItemId: z.string().nullable(),
	receipt: DelegatedApprovalReceiptSchema,
});
export const ListDecidedForYouInputSchema = z.strictObject({
	limit: z.number().int().min(1).max(100).default(25),
	before: z.string().min(1).max(200).optional(),
});
export const ListDecidedForYouResultSchema = z.object({
	data: z.array(DecidedForYouItemSchema),
	nextBefore: z.string().nullable(),
});
export const ReopenDelegatedApprovalInputSchema = z.strictObject({
	requestId: z.uuid(),
	source: z.enum(["interaction", "runtime"]).default("interaction"),
	undo: z.boolean().default(false),
});
