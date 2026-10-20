import type { LearningInteractionEvent } from "@tedix/api-contract/schemas/learning-feedback";

/** UTC schedule is explicit so every device agrees about a batch boundary. */
export function deckBatchWindow(times: readonly string[], now = new Date()) {
	const day = now.toISOString().slice(0, 10);
	const candidates = [-1, 0, 1]
		.flatMap((offset) => {
			const date = new Date(`${day}T00:00:00Z`);
			date.setUTCDate(date.getUTCDate() + offset);
			return times.map(
				(time) => new Date(`${date.toISOString().slice(0, 10)}T${time}:00Z`),
			);
		})
		.sort((a, b) => a.getTime() - b.getTime());
	return {
		key: candidates
			.filter((date) => date <= now)
			.at(-1)!
			.toISOString(),
		next: candidates.find((date) => date > now)!,
	};
}

export function attentionMetrics(
	events: readonly LearningInteractionEvent[],
	now = new Date(),
	routingPolicyVersion?: number,
) {
	const unique = [
		...new Map(events.map((event) => [event.id, event])).values(),
	];
	const today = now.toISOString().slice(0, 10);
	const decisions = unique.filter(
		(event) =>
			event.surface === "decision_deck_action" &&
			event.metadata?.decisionChoice !== "later",
	);
	const shownToday = [
		...new Set(
			unique
				.filter(
					(event) =>
						["decision_deck_shown", "decision_deck_action"].includes(
							event.surface,
						) &&
						event.occurredAt.startsWith(today) &&
						(routingPolicyVersion === undefined ||
							event.metadata?.routingPolicyVersion === routingPolicyVersion),
				)
				.map((event) => event.targetId ?? event.id),
		),
	];
	const elapsed = decisions.flatMap((event) =>
		typeof event.metadata?.elapsedMs === "number" &&
		Number.isFinite(event.metadata.elapsedMs) &&
		event.metadata.elapsedMs >= 0
			? [event.metadata.elapsedMs]
			: [],
	);
	const firstViewElapsed = decisions
		.flatMap((event) =>
			typeof event.metadata?.firstViewedAt === "number" &&
			typeof event.metadata.elapsedMs === "number" &&
			Number.isFinite(event.metadata.elapsedMs) &&
			event.metadata.elapsedMs >= 0
				? [event.metadata.elapsedMs]
				: [],
		)
		.sort((a, b) => a - b);
	const days = new Set(decisions.map((event) => event.occurredAt.slice(0, 10)));
	const middle = Math.floor(firstViewElapsed.length / 2);
	const actions = unique.filter(
		(event) =>
			event.surface === "decision_deck_action" ||
			(event.surface === "decision_deck" &&
				event.metadata?.reaction === "skip" &&
				event.metadata.decisionChoice === "later"),
	);
	const observedDetails = decisions.filter(
		(event) =>
			typeof event.metadata?.firstViewedAt === "number" &&
			typeof event.metadata.railOpenedBeforeDecision === "boolean",
	);
	let streak = 0;
	const cursor = new Date(`${today}T00:00:00Z`);
	if (!days.has(today)) cursor.setUTCDate(cursor.getUTCDate() - 1);
	while (days.has(cursor.toISOString().slice(0, 10))) {
		streak++;
		cursor.setUTCDate(cursor.getUTCDate() - 1);
	}
	return {
		medianMs: firstViewElapsed.length
			? firstViewElapsed.length % 2
				? firstViewElapsed[middle]!
				: (firstViewElapsed[middle - 1]! + firstViewElapsed[middle]!) / 2
			: null,
		// The denominators behind each rate/count, exported so a tile can name
		// the population it measures instead of implying "all time".
		decisionCount: decisions.length,
		observedDecisionCount: observedDetails.length,
		actionCount: actions.length,
		withoutDetailsRate: observedDetails.length
			? observedDetails.filter(
					(event) => event.metadata?.railOpenedBeforeDecision === false,
				).length / observedDetails.length
			: null,
		measuredDecisions: firstViewElapsed.length,
		laterCount: actions.filter(
			(event) => event.metadata?.decisionChoice === "later",
		).length,
		notThisCount: actions.filter(
			(event) => event.metadata?.decisionChoice === "reject",
		).length,
		changeRequestCount: actions.filter(
			(event) => event.metadata?.cardAction === "request_changes",
		).length,
		averageMs: elapsed.length
			? elapsed.reduce((sum, value) => sum + value, 0) / elapsed.length
			: null,
		delegationRate: decisions.length
			? decisions.filter(
					(event) => event.metadata?.decisionChoice === "delegate",
				).length / decisions.length
			: null,
		correctionRate: decisions.length
			? decisions.filter((event) =>
					["edited", "rejected", "manually_replaced"].includes(event.eventKind),
				).length / decisions.length
			: null,
		cardsToday: shownToday.length,
		shownToday,
		decisionsToday: decisions.filter((event) =>
			event.occurredAt.startsWith(today),
		).length,
		returnVisitsToday: Math.max(
			0,
			unique.filter(
				(event) =>
					event.surface === "decision_deck_visit" &&
					event.occurredAt.startsWith(today),
			).length - 1,
		),
		streak,
	};
}
