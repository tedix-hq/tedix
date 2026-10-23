import * as z from "zod";
import {
	DecisionEffectSchema,
	ProtectedEffectSchema,
} from "./decision-effects";
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

/** Versions observed by the author, compared with canonical tenant state on each read. */
const DecisionSourceSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("work"),
		id: z.uuid(),
		version: z.number().int().positive(),
		commentCount: z.number().int().nonnegative(),
	}),
	z.strictObject({
		kind: z.literal("email_thread"),
		id: z.string().min(1).max(300),
		tediId: z.uuid(),
		updatedAt: z.string().nullable(),
		lastMessageAt: z.string(),
		messageCount: z.number().int().nonnegative(),
	}),
	z.strictObject({
		kind: z.literal("output"),
		id: z.uuid(),
		revisionId: z.uuid(),
	}),
]);
export type DecisionSource = z.infer<typeof DecisionSourceSchema>;
export const DecisionSourcesSchema = z
	.array(DecisionSourceSchema)
	.min(1)
	.max(10)
	.describe(
		"Versions actually read to establish this card's facts. Rechecked before display and answer. Include every source; a new email, Work comment or document revision requires a new card.",
	);

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
	sources: DecisionSourcesSchema.optional(),
	tasteOrStrategy: z.boolean().default(false),
	protectedEffects: z.array(ProtectedEffectSchema).max(7).default([]),
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
		.max(5)
		.refine(
			(options) =>
				options.length < 5 ||
				options.some((option) => option.intent === "reject"),
			"A fifth option must include a decline action",
		)
		.refine(
			(options) =>
				new Set(options.map((option) => option.id)).size === options.length,
			"Option ids must be unique",
		)
		.transform((options) => {
			if (options.some((option) => option.intent === "reject")) return options;
			let id = "not-needed";
			while (options.some((option) => option.id === id)) id += "-no";
			const withDecline = [...options];
			withDecline.splice(
				options.findIndex((option) => option.intent === "approve") + 1,
				0,
				{
					id,
					label: "No / Not needed",
					intent: "reject",
					consequence:
						"Declines this request without approving its proposed action.",
					cost: "No proposed action is authorized.",
				},
			);
			return withDecline;
		}),
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
	/**
	 * Human-reserved action classes (critical-actions.v1) that keep an ask with
	 * its person when its subject names one. Read from the subject only: agent
	 * summaries in the prompt mention such words without asking for the act.
	 */
	criticalSubjectClasses: z.array(z.string().min(1)).max(20).optional(),
	/** Owner-only subjects no action class covers, such as tax facts. */
	criticalSubjectPatterns: z
		.array(z.string().min(1).max(500))
		.max(30)
		.optional(),
	learnedMinimumExamples: z.number().int().positive(),
	learnedFeedThreshold: z.number().negative(),
	valuableClasses: z.array(z.string().min(1)).max(100),
	feedClasses: z.array(z.string().min(1)).max(100),
});
export type DeckRoutingPolicy = z.infer<typeof DeckRoutingPolicySchema>;
export const DEFAULT_DECK_ROUTING =
	DeckRoutingPolicySchema.parse(routingPolicy);

/** A class id matches a policy class exactly or as its `.`/`:` prefix. */
export function matchesDeckClass(classId: string, classes: readonly string[]) {
	return classes.some(
		(value) =>
			classId === value ||
			classId.startsWith(`${value}.`) ||
			classId.startsWith(`${value}:`),
	);
}

/** The reviewer taught "less like this" for the class often enough to stop asking. */
export function learnedFeed(
	usefulness: { value: number; examples: number } | undefined,
	policy: DeckRoutingPolicy,
) {
	return (
		!!usefulness &&
		usefulness.examples >= policy.learnedMinimumExamples &&
		usefulness.value <= policy.learnedFeedThreshold
	);
}

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
		matchesDeckClass(card.classId, classes);
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
	if (reason === "valuable" && learnedFeed(card.learnedUsefulness, policy))
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
