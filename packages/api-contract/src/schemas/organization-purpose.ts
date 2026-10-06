import * as z from "zod";

export const PurposeCharterStatusSchema = z.enum(["active", "superseded"]);

export const OrganizationPurposeCharterSchema = z.object({
	id: z.uuid(),
	orgId: z.uuid(),
	version: z.number().int().positive(),
	status: PurposeCharterStatusSchema,
	purpose: z.string(),
	principles: z.array(z.string()),
	strategicTheses: z.array(z.string()),
	nonGoals: z.array(z.string()),
	evidenceRefs: z.array(z.string()),
	reviewCadenceDays: z.number().int().positive(),
	revisionReason: z.string(),
	createdByUserId: z.string().nullable(),
	createdAt: z.string(),
	activatedAt: z.string(),
	supersededAt: z.string().nullable(),
});
export type OrganizationPurposeCharter = z.infer<
	typeof OrganizationPurposeCharterSchema
>;

const CharterListFieldSchema = z
	.array(z.string().trim().min(1).max(500))
	.max(20)
	.default([]);

export const CreatePurposeCharterRevisionInputSchema = z.object({
	purpose: z.string().trim().min(20).max(3000),
	principles: CharterListFieldSchema,
	strategicTheses: CharterListFieldSchema,
	nonGoals: CharterListFieldSchema,
	evidenceRefs: z.array(z.string().trim().min(1).max(1000)).max(50).default([]),
	reviewCadenceDays: z.number().int().min(7).max(365).default(30),
	revisionReason: z.string().trim().min(3).max(1000),
});
export type CreatePurposeCharterRevisionInput = z.infer<
	typeof CreatePurposeCharterRevisionInputSchema
>;

export const OwnerAttentionItemSchema = z.object({
	id: z.uuid(),
	title: z.string(),
	kind: z.enum(["decision", "exception", "outcome"]),
	reason: z.string(),
	priority: z.enum(["critical", "high", "medium", "low"]),
	objectiveId: z.uuid().nullable(),
	projectId: z.string().nullable(),
	updatedAt: z.string(),
	blocking: z.boolean(),
});

export const OrganizationOwnerBriefSchema = z.object({
	generatedAt: z.string(),
	purposeCharter: OrganizationPurposeCharterSchema.nullable(),
	needsJudgment: z.array(OwnerAttentionItemSchema).max(3),
	exceptions: z.array(OwnerAttentionItemSchema).max(3),
	outcomes: z.array(OwnerAttentionItemSchema).max(3),
	drift: z.object({
		severity: z.enum(["none", "watch", "action"]),
		activeObjectiveCount: z.number().int().nonnegative(),
		unlinkedObjectiveCount: z.number().int().nonnegative(),
		openWorkCount: z.number().int().nonnegative(),
		unlinkedOpenWorkCount: z.number().int().nonnegative(),
		activeOperationalExceptionCount: z.number().int().nonnegative(),
		expiredOperationalExceptionCount: z.number().int().nonnegative(),
		legacyUnclassifiedOpenWorkCount: z.number().int().nonnegative(),
		charterReviewOverdue: z.boolean(),
		summary: z.string(),
	}),
});
export type OrganizationOwnerBrief = z.infer<
	typeof OrganizationOwnerBriefSchema
>;
