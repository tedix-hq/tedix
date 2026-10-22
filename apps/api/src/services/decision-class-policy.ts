import {
	DecisionEnvelopeSchema,
	decisionNeedsPerson,
	type DecisionDeckConfig,
	type DeckRoutingPolicy,
} from "@tedix/api-contract/schemas/os-decision-deck";
import type { LearningInteractionEvent } from "@tedix/api-contract/schemas/learning-feedback";
import type { CardReviewSource } from "@tedix/api-contract/schemas/os-card-review";
import type { ReviewCard } from "@tedix/api-contract/utils/card-review";
import { unchangedApprovalStreak } from "@tedix/api-contract/utils/decision-class-streak";
import {
	type DecisionClassPolicy,
	type FactoryAutonomyEvent,
	factoryAgentEnvelope,
	factoryCardBlockers,
	factoryClassEvidence,
	factoryClassPolicy,
} from "@tedix/api-contract/utils/factory-class-autonomy";

/** A class can earn quiet delivery only inside the existing drafting permission. */
export function learnedClassDelivery(input: {
	metadata: Record<string, unknown> | null;
	policies: DecisionDeckConfig["classPolicies"];
	events: readonly Pick<
		LearningInteractionEvent,
		| "id"
		| "clientEventId"
		| "actorType"
		| "actorId"
		| "targetId"
		| "metadata"
		| "occurredAt"
	>[];
	userId: string;
	sample: number;
}) {
	const parsed = DecisionEnvelopeSchema.safeParse(input.metadata?.decisionDeck);
	if (!parsed.success) return "review";
	const decision = parsed.data;
	const policy = input.policies[decision.classId];
	if (
		!policy?.autoApprove ||
		decisionNeedsPerson(decision) ||
		(decision.expiresAt && Date.parse(decision.expiresAt) <= Date.now())
	)
		return "review";
	const { unchanged } = unchangedApprovalStreak(
		input.events,
		decision.classId,
		input.userId,
	);
	return unchanged >= policy.unchangedThreshold &&
		input.sample >= policy.auditSampleRate
		? "auto"
		: "review";
}

/**
 * Earned quiet delivery for one factory card and one person. Only a class the
 * source lists as agent-decidable is a candidate, and it passes through the
 * same gate as any other class: protected, expired, outbound, approval,
 * one-way and taste cards, critical classes and human-reserved actions always
 * stay with the person.
 */
export function factoryCardDelivery(input: {
	source: CardReviewSource;
	card: ReviewCard;
	events: readonly FactoryAutonomyEvent[];
	userId: string;
	sample: number;
	policies?: Record<string, DecisionClassPolicy>;
	routing?: DeckRoutingPolicy;
}): "auto" | "review" {
	const envelope = factoryAgentEnvelope(input.source, input.card);
	if (
		!envelope ||
		factoryCardBlockers(input.source, input.card, input.routing).length > 0
	)
		return "review";
	return learnedClassDelivery({
		metadata: { decisionDeck: envelope },
		policies: {
			[envelope.classId]: factoryClassPolicy(envelope.classId, input.policies),
		},
		events: factoryClassEvidence(input.events, envelope.classId, input.userId)
			.events,
		userId: input.userId,
		sample: input.sample,
	});
}
