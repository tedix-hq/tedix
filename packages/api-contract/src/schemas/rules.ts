import * as z from "zod";

export const RuleScopeSchema = z.enum(["organization", "personal"]);
export const RuleStateSchema = z.enum([
	"pending",
	"active",
	"retired",
	"rejected",
]);
export const RuleSchema = z.object({
	id: z.string(),
	text: z.string(),
	scope: RuleScopeSchema,
	ownerUserId: z.string().nullable(),
	origin: z.enum(["mined", "written"]),
	state: RuleStateSchema,
	reviewStatus: z.string().nullable(),
	revision: z.number().int().positive(),
	reason: z.string().nullable(),
	source: z.string().nullable(),
	createdAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
	history: z.array(
		z.object({
			revision: z.number().int(),
			text: z.string(),
			writtenAt: z.string().nullable(),
		}),
	),
});
export type Rule = z.infer<typeof RuleSchema>;
export const CreateRuleInputSchema = z.strictObject({
	text: z.string().trim().min(1).max(8000),
	scope: RuleScopeSchema,
	reason: z.string().trim().min(1).max(2000).optional(),
	source: z.string().trim().min(1).max(2000).optional(),
});
export const GetRuleInputSchema = z.strictObject({ ruleId: z.string().uuid() });
export const ChangeRuleInputSchema = GetRuleInputSchema.extend({
	expectedRevision: z.number().int().positive(),
	reason: z.string().trim().min(1).max(2000).optional(),
});
export const UpdateRuleInputSchema = ChangeRuleInputSchema.extend({
	text: z.string().trim().min(1).max(8000),
	source: z.string().trim().min(1).max(2000).optional(),
});
export const ListRulesInputSchema = z.strictObject({
	scope: RuleScopeSchema.optional(),
	state: RuleStateSchema.optional(),
	limit: z.number().int().min(1).max(100).default(50),
	offset: z.number().int().min(0).default(0),
});
export const ListRulesResultSchema = z.object({
	rules: z.array(RuleSchema),
	nextOffset: z.number().int().nullable(),
});
