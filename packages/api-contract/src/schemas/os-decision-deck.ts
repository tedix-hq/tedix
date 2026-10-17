import * as z from "zod";

export const DECISION_DECK_ENTRY = "tedix:app/decision-deck";
export const DecisionKindSchema = z.enum([
	"outbound",
	"proposal",
	"question",
	"approval",
	"decision",
	"adr",
]);

/** Display and learning context; never an execution or consent grant. */
export const DecisionEnvelopeSchema = z.strictObject({
	version: z.literal(1),
	kind: DecisionKindSchema,
	classId: z.string().trim().min(1).max(100),
	proposal: z.string().trim().min(1).max(500),
	whyNow: z.string().min(1).max(2000),
	recommendation: z.string().min(1).max(4000),
	reversibility: z.enum(["one_way", "two_way", "unknown"]),
	tasteOrStrategy: z.boolean().default(false),
	protectedEffects: z
		.array(
			z.enum([
				"data",
				"contract",
				"production",
				"money",
				"consent",
				"message",
				"commitment",
			]),
		)
		.max(7)
		.default([]),
	blastRadius: z.string().min(1).max(1000),
	confidence: z.number().min(0).max(1).nullable(),
	costOfWaiting: z.string().min(1).max(1000),
	expiresAt: z.iso.datetime().optional(),
	nobodyOn: z.boolean().optional(),
	reasoning: z.string().min(1).max(8000),
	lessons: z
		.array(
			z.strictObject({
				id: z.string().min(1).max(200),
				text: z.string().min(1).max(2000),
			}),
		)
		.max(20)
		.default([]),
	options: z
		.array(
			z.strictObject({
				id: z
					.string()
					.min(1)
					.max(100)
					.refine((id) => id !== "change", "change is reserved for the editor"),
				label: z.string().min(1).max(120),
				intent: z.enum(["approve", "reject", "delegate", "later"]),
				consequence: z.string().min(1).max(2000),
				cost: z.string().min(1).max(1000),
			}),
		)
		.min(2)
		.max(4)
		.refine(
			(options) =>
				new Set(options.map((option) => option.id)).size === options.length,
			"Option ids must be unique",
		),
});
export type DecisionEnvelope = z.infer<typeof DecisionEnvelopeSchema>;

export function decisionNeedsPerson(decision: DecisionEnvelope): boolean {
	return (
		decision.kind === "outbound" ||
		decision.kind === "approval" ||
		decision.protectedEffects.length > 0 ||
		decision.reversibility !== "two_way" ||
		decision.tasteOrStrategy
	);
}

export const DecisionClassPolicySchema = z.strictObject({
	unchangedThreshold: z.number().int().min(1).max(100).default(5),
	auditSampleRate: z.number().min(0).max(1).default(0.1),
	autoApprove: z.boolean().default(false),
});
export const DecisionClassPoliciesSchema = z.record(
	z.string().min(1).max(100),
	DecisionClassPolicySchema,
);

export const DecisionDeckConfigSchema = z.strictObject({
	version: z.literal(1),
	projectId: z.uuid().optional(),
	limit: z.number().int().min(1).max(100).default(50),
	unchangedThreshold: z.number().int().min(1).max(100).default(5),
	dailyAttentionBudget: z.number().int().min(1).max(100).default(10),
	auditSampleRate: z.number().min(0).max(1).default(0.1),
	defaultLowStakesToDelegate: z.boolean().default(true),
	gamification: z.boolean().default(true),
	dailyGoal: z.number().int().min(1).max(100).default(7),
	batchTimesUtc: z
		.array(z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/))
		.min(1)
		.max(24)
		.default(["09:00", "16:00"]),
	classPolicies: DecisionClassPoliciesSchema.default({}),
	examples: z.array(DecisionEnvelopeSchema).max(12).default([]),
});
export type DecisionDeckConfig = z.infer<typeof DecisionDeckConfigSchema>;
