import type { LearningInteractionEvent } from "../schemas/learning-feedback";

export type DecisionStreakEvent = Pick<
	LearningInteractionEvent,
	| "id"
	| "clientEventId"
	| "actorType"
	| "actorId"
	| "targetId"
	| "metadata"
	| "occurredAt"
>;

/**
 * One person's latest run of unchanged approvals for a class, newest first.
 * Later is neutral; any other decision ends the run. Each target counts once.
 */
export function unchangedApprovalStreak(
	events: readonly DecisionStreakEvent[],
	classId: string,
	userId: string,
): { unchanged: number; evidenceIds: string[] } {
	const seen = new Set<string>();
	const evidenceIds: string[] = [];
	for (const event of [...events].sort((a, b) =>
		b.occurredAt.localeCompare(a.occurredAt),
	)) {
		if (
			event.actorType !== "user" ||
			event.actorId !== userId ||
			!event.clientEventId.startsWith("decision-capture:") ||
			event.metadata?.decisionClass !== classId
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
		evidenceIds.push(event.id);
	}
	return { unchanged: evidenceIds.length, evidenceIds };
}
