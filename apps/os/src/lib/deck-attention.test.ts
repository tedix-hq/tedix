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
			event("return", "decision_deck_visit", ""),
		],
		new Date("2026-10-17T14:00:00Z"),
	);
	const current = event("current", "decision_deck_shown", "");
	current.metadata = { ...current.metadata, routingPolicyVersion: 1 };
	expect(
		attentionMetrics([first, current], new Date("2026-10-17T14:00:00Z"), 1)
			.cardsToday,
	).toBe(1);
	expect(result).toMatchObject({
		cardsToday: 3,
		decisionsToday: 2,
		returnVisitsToday: 1,
		averageMs: 2000,
		delegationRate: 0.5,
		correctionRate: 0.5,
		streak: 1,
	});
});

it("uses first-view timings for the median, leaves unknown Details history unknown, and keeps Later separate", () => {
	const make = (id: string, metadata: Record<string, unknown>) =>
		LearningInteractionEventSchema.parse({
			id,
			organizationId: "fictional-org",
			actorType: "user",
			actorId: "fictional-user",
			tediId: null,
			clientEventId: id,
			signalClass: "quality",
			eventKind: "accepted",
			scopeKind: "personal",
			scopeId: "fictional-user",
			issueKey: null,
			surface: "decision_deck_action",
			targetType: "decision",
			targetId: id,
			threadId: null,
			runId: null,
			occurredAt: "2026-10-19T12:00:00Z",
			createdAt: "2026-10-19T12:00:00Z",
			metadata,
		});
	const result = attentionMetrics([
		make("one", {
			decisionChoice: "approve",
			firstViewedAt: 1000,
			elapsedMs: 10000,
			railOpenedBeforeDecision: false,
		}),
		make("two", {
			decisionChoice: "reject",
			firstViewedAt: 1000,
			elapsedMs: 50000,
			railOpenedBeforeDecision: true,
		}),
		make("old", {
			decisionChoice: "approve",
			elapsedMs: 999999,
			railOpenedBeforeDecision: false,
		}),
		make("later", {
			decisionChoice: "later",
			firstViewedAt: 1000,
			elapsedMs: 200000,
		}),
		make("changes", {
			decisionChoice: "change",
			cardAction: "request_changes",
		}),
		{
			...make("fallback", { decisionChoice: "later", reaction: "skip" }),
			surface: "decision_deck",
		},
	]);
	expect(result).toMatchObject({
		medianMs: 30000,
		measuredDecisions: 2,
		withoutDetailsRate: 0.5,
		laterCount: 2,
		notThisCount: 1,
		changeRequestCount: 1,
	});
});
