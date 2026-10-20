import * as z from "zod";
import { DecisionEffectSchema } from "./decision-effects";
import { CardReviewSourceSchema } from "./os-card-review";
import routingPolicy from "../assets/deck-routing.v1.json";

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
	preview: z.strictObject({ body: z.string().min(1).max(40000) }).optional(),
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
				effect: DecisionEffectSchema.optional(),
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

export const DeckRoutingPolicySchema = z.strictObject({
	version: z.literal(1),
	deadlineWindowHours: z.number().positive().max(720),
	criticalEffects: z.array(z.string().min(1)).max(30),
	criticalClasses: z.array(z.string().min(1)).max(100),
	criticalActionPatterns: z.array(z.string().min(1).max(500)).max(30),
	criticalQuestionPatterns: z.array(z.string().min(1).max(500)).max(30),
	learnedMinimumExamples: z.number().int().positive(),
	learnedFeedThreshold: z.number().negative(),
	valuableClasses: z.array(z.string().min(1)).max(100),
	feedClasses: z.array(z.string().min(1)).max(100),
});
export type DeckRoutingPolicy = z.infer<typeof DeckRoutingPolicySchema>;
export const DEFAULT_DECK_ROUTING =
	DeckRoutingPolicySchema.parse(routingPolicy);

/** Display routing never grants execution, approval, consent or permission. */
export function classifyDeckCard(
	card: {
		kind: string;
		classId: string;
		risk?: string | null;
		action?: string;
		learnedUsefulness?: { value: number; examples: number };
		protectedEffects?: readonly string[];
		tasteOrStrategy?: boolean;
		needsPerson: boolean;
		effectKnown?: boolean;
		dueAt?: string | null;
	},
	policy: DeckRoutingPolicy = DEFAULT_DECK_ROUTING,
	now = new Date(),
) {
	const matches = (classes: readonly string[]) =>
		classes.some(
			(value) =>
				card.classId === value ||
				card.classId.startsWith(`${value}.`) ||
				card.classId.startsWith(`${value}:`),
		);
	let reason = "routine";
	if (card.needsPerson) {
		if (
			card.risk === "critical" ||
			(card.kind === "question" &&
				!!card.action &&
				policy.criticalQuestionPatterns.some((pattern) =>
					new RegExp(pattern, "i").test(card.action!),
				)) ||
			(card.kind === "approval" &&
				!!card.action &&
				policy.criticalActionPatterns.some((pattern) =>
					new RegExp(pattern, "i").test(card.action!.replace(/[_:.]/g, " ")),
				)) ||
			matches(policy.criticalClasses) ||
			card.protectedEffects?.some((effect) =>
				policy.criticalEffects.includes(effect),
			)
		)
			reason = "critical";
		else if (card.effectKnown === false) reason = "missing_effect";
		else if (matches(policy.feedClasses)) reason = "routine";
		else if (matches(policy.valuableClasses)) reason = "valuable";
		else if (card.tasteOrStrategy) reason = "owner_strategy";
		else if (
			card.dueAt &&
			Number.isFinite(Date.parse(card.dueAt)) &&
			Math.abs(Date.parse(card.dueAt) - now.getTime()) <=
				policy.deadlineWindowHours * 3600000
		)
			reason = "owner_deadline";
	}
	if (
		reason === "valuable" &&
		card.learnedUsefulness &&
		card.learnedUsefulness.examples >= policy.learnedMinimumExamples &&
		card.learnedUsefulness.value <= policy.learnedFeedThreshold
	)
		reason = "learned_feed";
	return {
		destination: ["routine", "learned_feed", "missing_effect"].includes(reason)
			? ("feed" as const)
			: ("deck" as const),
		reason,
		policyVersion: policy.version,
		classId: card.classId,
	};
}

export const DecisionDeckConfigSchema = z.strictObject({
	version: z.literal(1),
	factorySources: z.array(CardReviewSourceSchema).max(10).default([]),
	projectId: z.uuid().optional(),
	limit: z.number().int().min(1).max(100).default(50),
	unchangedThreshold: z.number().int().min(1).max(100).default(5),
	dailyAttentionBudget: z.number().int().min(1).max(100).default(10),
	/** A ready message draft older than this joins "Drafted, not sent". */
	staleDraftHours: z.number().int().min(1).max(720).default(24),
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
	routing: DeckRoutingPolicySchema.optional(),
	examples: z.array(DecisionEnvelopeSchema).max(12).default([]),
});
export type DecisionDeckConfig = z.infer<typeof DecisionDeckConfigSchema>;
