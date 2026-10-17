import {
	DecisionEnvelopeSchema,
	decisionNeedsPerson,
	type DecisionDeckConfig,
} from "@tedix/api-contract/schemas/os-decision-deck";
import type { LearningInteractionEvent } from "@tedix/api-contract/schemas/learning-feedback";

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
	const seen = new Set<string>();
	let unchanged = 0;
	for (const event of [...input.events].sort((a, b) =>
		b.occurredAt.localeCompare(a.occurredAt),
	)) {
		if (
			event.actorType !== "user" ||
			event.actorId !== input.userId ||
			!event.clientEventId.startsWith("decision-capture:") ||
			event.metadata?.decisionClass !== decision.classId
		)
			continue;
		if (event.metadata.decisionChoice === "later") continue;
		if (
			event.metadata.decisionChoice !== "approve" ||
			event.metadata.feedbackSignal !== "approve-as-is"
		)
			break;
		const key = event.targetId ?? event.id;
		if (seen.has(key)) continue;
		seen.add(key);
		unchanged++;
	}
	return unchanged >= policy.unchangedThreshold &&
		input.sample >= policy.auditSampleRate
		? "auto"
		: "review";
}
