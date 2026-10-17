import { expect, it } from "vite-plus/test";
import { LearningInteractionEventSchema } from "@tedix/api-contract/schemas/learning-feedback";
import { attentionMetrics, deckBatchWindow } from "./deck-attention";

it("advances at the scheduled boundary and names tomorrow's next batch after the last one", () => {
	const times = ["16:00", "09:00"];
	expect(
		deckBatchWindow(times, new Date("2026-10-17T15:59:59Z")).next.toISOString(),
	).toBe("2026-10-17T16:00:00.000Z");
	expect(
		deckBatchWindow(times, new Date("2026-10-17T16:00:00Z")),
	).toMatchObject({ key: "2026-10-17T16:00:00.000Z" });
	expect(
		deckBatchWindow(times, new Date("2026-10-17T23:00:00Z")).next.toISOString(),
	).toBe("2026-10-18T09:00:00.000Z");
});
it("measures all five attention signals once, counting deferred cards as attention without counting them as decisions", () => {
	const event = (
		id: string,
		surface: string,
		choice: string,
		elapsedMs = 1000,
	) =>
		LearningInteractionEventSchema.parse({
			id,
			organizationId: "fictional-org",
			actorType: "user",
			actorId: "fictional-user",
			tediId: null,
			clientEventId: id,
			signalClass: "quality",
			eventKind: choice === "change" ? "edited" : "accepted",
			scopeKind: "personal",
			scopeId: "fictional-user",
			issueKey: null,
			surface,
			targetType: null,
			targetId: null,
			threadId: null,
			runId: null,
			metadata: {
				answerSource: "os-decision-card",
				decisionChoice: choice,
				elapsedMs,
			},
			occurredAt: "2026-10-17T10:00:00Z",
			createdAt: "2026-10-17T10:00:00Z",
		});
	const first = event("one", "decision_deck_action", "delegate");
	const result = attentionMetrics(
		[
			first,
			first,
			event("two", "decision_deck_action", "change", 3000),
			event("later", "decision_deck_action", "later"),
			event("learning", "decision_capture", "approve"),
			event("visit", "decision_deck_visit", ""),
		],
		new Date("2026-10-17T14:00:00Z"),
	);
	expect(result).toMatchObject({
		cardsToday: 3,
		decisionsToday: 2,
		visitsToday: 1,
		averageMs: 2000,
		delegationRate: 0.5,
		correctionRate: 0.5,
		streak: 1,
	});
});
