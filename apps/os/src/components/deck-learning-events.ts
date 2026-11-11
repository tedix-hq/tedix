import type { QueryClient } from "@tanstack/react-query";
import type { ContextType } from "react";
import { DEFAULT_DECK_ROUTING } from "@tedix/api-contract/schemas/os-decision-deck";
import type { DecisionCardPresentation } from "@tedix/api-contract/schemas/decision-card-presentation";
import type { LearningInteractionEvent } from "@tedix/api-contract/schemas/learning-feedback";
import type { DecisionAttentionContext } from "@/components/decision-attention-context";
import { osApi } from "@/lib/api";
import {
	cardDecisionTiming,
	cardDetailsOpened,
	cardFirstView,
	markCardDetails,
	readCardFirstView,
} from "@/lib/card-first-view";
import type { DecisionLearningReceipt } from "@/lib/decision-deck";
import { osQuery } from "@/lib/os-query-options";

type DeckChoice = Parameters<
	NonNullable<ContextType<typeof DecisionAttentionContext>>
>[0];

/** The card on screen, as the learning records name it. */
export interface DeckLearningCard {
	client: QueryClient;
	cardId: string;
	classId: string;
	sourceVersion: number | string | null;
	viewKey: string | null;
	railOpened: boolean;
	onLearningEvent: (eventId: string) => void;
}

const refreshLearning = (client: QueryClient) =>
	client.invalidateQueries({ queryKey: osQuery.learningFeedback.key() });

/** A person's own past choices on decision cards, read from the learning record. */
export function decisionLearningReceipts(
	events: readonly LearningInteractionEvent[],
): DecisionLearningReceipt[] {
	return events.flatMap((event) => {
		const meta = event.metadata;
		return event.surface === "decision_capture" &&
			meta?.answerSource === "os-decision-card" &&
			typeof meta.decisionClass === "string"
			? [
					{
						id: event.id,
						requestId: event.targetId ?? undefined,
						classId: meta.decisionClass,
						choice: String(meta.decisionChoice ?? "unknown"),
						signal: String(meta.feedbackSignal ?? "unknown"),
						at: event.occurredAt,
					},
				]
			: [];
	});
}

/** "Not now": the card comes back; the skip is recorded so ranking can learn from it. */
export function recordDeckLater(
	card: DeckLearningCard & { projectId: string },
) {
	void osApi.learningFeedback
		.recordInteraction({
			clientEventId: crypto.randomUUID(),
			eventKind: "ignored",
			scope: { kind: "personal" },
			surface: "decision_deck",
			targetType: "work_interaction",
			targetId: card.cardId,
			metadata: {
				decisionClass: card.classId,
				decisionChoice: "later",
				...cardDecisionTiming(card.viewKey),
				sourceVersion: card.sourceVersion,
				railOpenedBeforeDecision:
					card.railOpened || cardDetailsOpened(card.viewKey),
				reaction: "skip",
				projectId: card.projectId,
			},
		})
		.then(async (result) => {
			if (!result.duplicate && result.event?.id)
				card.onLearningEvent(result.event.id);
			await refreshLearning(card.client);
		})
		.catch(() => {});
}

/**
 * A card was shown, or a choice on it succeeded. The card still owns its
 * action and receipt; this only records what the Deck observed.
 */
export function recordDeckChoice(
	choice: DeckChoice,
	card: DeckLearningCard & {
		viewKey: string;
		userId: string;
		now: Date;
		deckProjectId: string | undefined;
		presentation: DecisionCardPresentation | null | undefined;
		optionIntent: (action: string) => string | undefined;
		onContextQuestion: (viewKey: string) => void;
	},
) {
	const { viewKey, presentation } = card;
	if (choice.signal === "opened_details") {
		markCardDetails(viewKey);
		return;
	}
	const shown = choice.signal === "shown";
	const firstViewedAt = shown
		? cardFirstView(viewKey)
		: readCardFirstView(viewKey);
	if (shown && presentation?.version === 2 && presentation.sourceFingerprint)
		void osApi.learningFeedback
			.cardContextPrompt({
				cardId: card.cardId,
				sourceFingerprint: presentation.sourceFingerprint,
				projectId: card.deckProjectId,
				limit: 100,
			})
			.then(({ ask }) => {
				if (ask) card.onContextQuestion(viewKey);
			})
			.catch(() => {});
	if (choice.learningClientEventId)
		card.onLearningEvent(choice.learningClientEventId);
	const intent = choice.intent ?? card.optionIntent(choice.action) ?? "approve";
	// One "shown" record per person, card and day, however often it renders.
	const eventKey = shown
		? crypto.subtle
				.digest(
					"SHA-256",
					new TextEncoder().encode(
						`${card.userId}:${card.cardId}:${card.now.toISOString().slice(0, 10)}`,
					),
				)
				.then(
					(hash) =>
						`deck-shown:${[...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`,
				)
		: Promise.resolve(`deck-action:${crypto.randomUUID()}`);
	void eventKey
		.then((clientEventId) =>
			osApi.learningFeedback.recordInteraction({
				clientEventId,
				signalClass: shown ? "lifecycle" : "quality",
				eventKind: shown
					? "delivered"
					: choice.signal === "rejected"
						? "rejected"
						: choice.signal === "edited"
							? "edited"
							: "accepted",
				scope: { kind: "personal" },
				surface: shown ? "decision_deck_shown" : "decision_deck_action",
				targetType: "decision",
				targetId: card.cardId,
				metadata: {
					answerSource: "os-decision-card",
					routingPolicyVersion: DEFAULT_DECK_ROUTING.version,
					decisionClass: card.classId,
					decisionChoice: intent,
					cardAction: choice.action,
					elapsedMs: shown
						? 0
						: firstViewedAt === undefined
							? choice.elapsedMs
							: Math.max(0, (choice.decidedAt ?? Date.now()) - firstViewedAt),
					...(firstViewedAt === undefined ? {} : { firstViewedAt }),
					sourceVersion: card.sourceVersion,
					railOpenedBeforeDecision:
						card.railOpened ||
						cardDetailsOpened(viewKey) ||
						choice.detailsOpened === true,
				},
			}),
		)
		.then(() => refreshLearning(card.client))
		.catch(() => {});
}
