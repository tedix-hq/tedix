import { describe, expect, it } from "vite-plus/test";
import type * as z from "zod";
import type { WorkInteractionInboxRowSchema } from "../schemas/work-interactions";
import { DecisionEnvelopeSchema } from "../schemas/os-decision-deck";
import {
	deadlineOverdue,
	deckAsk,
	deckAskKind,
	deckCardDeadline,
	draftedNotSent,
} from "./deck-ask";
import { compareDecisionFreshness, projectDeckCards } from "./deck-projection";
import { orderCuratedDeck } from "./deck-curator";
import { attentionMarkdown, deckDisplayCard } from "./attention-app-view";
import { retiredDeckFeedItems } from "./activity-feed";

type Row = z.infer<typeof WorkInteractionInboxRowSchema>;
const now = new Date("2026-10-20T12:00:00.000Z");
const envelope = (kind: string, extra: Record<string, unknown> = {}) =>
	DecisionEnvelopeSchema.parse({
		version: 1,
		kind,
		classId: "fictional.class",
		proposal: "Pick the supplier for the fictional orchard?",
		whyNow: "The quote expires.",
		recommendation: "Pick Maple Supply.",
		reversibility: "two_way",
		blastRadius: "One order.",
		confidence: 0.8,
		costOfWaiting: "The price rises.",
		reasoning: "Cheapest on-time option.",
		options: [
			{
				id: "yes",
				label: "Pick Maple",
				intent: "approve",
				consequence: "Order placed.",
				cost: "None",
			},
			{
				id: "no",
				label: "Wait",
				intent: "reject",
				consequence: "Nothing changes.",
				cost: "None",
			},
		],
		...extra,
	});

describe("deckAskKind", () => {
	it("maps typed card data to what the card asks of the person", () => {
		expect(deckAskKind({ kind: "approval" })).toBe("consent");
		expect(
			deckAskKind({
				kind: "decision",
				decision: envelope("decision", { protectedEffects: ["consent"] }),
			}),
		).toBe("consent");
		expect(
			deckAskKind({
				kind: "question",
				request: { metadata: { localImport: true } },
			}),
		).toBe("consent");
		expect(deckAskKind({ kind: "outbound" })).toBe("send");
		expect(
			deckAskKind({
				kind: "proposal",
				decision: envelope("proposal", { protectedEffects: ["message"] }),
			}),
		).toBe("send");
		expect(
			deckAskKind({ kind: "decision", factory: { draft: "Reply text" } }),
		).toBe("approve_draft");
		expect(
			deckAskKind({
				kind: "decision",
				decision: envelope("decision", { preview: { body: "Draft ADR" } }),
			}),
		).toBe("approve_draft");
		expect(deckAskKind({ kind: "decision", factory: { draft: " " } })).toBe(
			"decide",
		);
		expect(deckAskKind({ kind: "question" })).toBe("answer");
		expect(deckAskKind({ kind: "proposal" })).toBe("decide");
		expect(deckAskKind({ kind: "adr" })).toBe("decide");
		expect(deckAskKind({ kind: "decision" })).toBe("decide");
	});
});

describe("deadlines", () => {
	it("takes the earliest of due date, decision expiry and approval expiry", () => {
		expect(
			deckCardDeadline({
				dueAt: "2026-10-22T09:00:00.000Z",
				decision: { expiresAt: "2026-10-21T09:00:00.000Z" },
				runtimeApproval: { expiresAt: "2026-10-23T09:00:00.000Z" },
			}),
		).toBe("2026-10-21T09:00:00.000Z");
		expect(deckCardDeadline({ dueAt: "not a date" })).toBeNull();
		expect(deckCardDeadline({})).toBeNull();
	});

	it("computes overdue against a fake clock and keeps date-only deadlines current all day", () => {
		expect(deadlineOverdue("2026-10-20T11:59:00.000Z", now)).toBe(true);
		expect(deadlineOverdue("2026-10-20T12:01:00.000Z", now)).toBe(false);
		expect(deadlineOverdue("2026-10-20", now, "Europe/Berlin")).toBe(false);
		expect(deadlineOverdue("2026-10-19", now, "Europe/Berlin")).toBe(true);
		// 23:30 UTC is already 21 October in Berlin.
		expect(
			deadlineOverdue(
				"2026-10-20",
				new Date("2026-10-20T23:30:00.000Z"),
				"Europe/Berlin",
			),
		).toBe(true);
		expect(deadlineOverdue(null, now)).toBe(false);
	});

	it("marks a send card drafted-not-sent only after the configured age", () => {
		expect(
			draftedNotSent(
				{ askKind: "send", requestedAt: "2026-10-19T12:00:00.000Z" },
				now,
				24,
			),
		).toBe(true);
		expect(
			draftedNotSent(
				{ askKind: "send", requestedAt: "2026-10-19T12:00:01.000Z" },
				now,
				24,
			),
		).toBe(false);
		expect(
			draftedNotSent(
				{ askKind: "decide", requestedAt: "2026-10-01T00:00:00.000Z" },
				now,
				24,
			),
		).toBe(false);
		expect(
			deckAsk(
				{ kind: "outbound", requestedAt: "2026-10-20T06:00:00.000Z" },
				now,
				{ staleDraftHours: 4 },
			),
		).toEqual({
			askKind: "send",
			deadline: null,
			overdue: false,
			draftedNotSent: true,
		});
	});
});

function row(
	id: string,
	metadata: Record<string, unknown>,
	dueAt: string | null = null,
) {
	return {
		request: {
			id,
			kind: "question",
			subject: `Fictional card ${id}?`,
			prompt: "What next?",
			metadata,
			requestedAt: "2026-10-18T10:00:00.000Z",
			dueAt,
			projectId: null,
			workItemId: null,
		},
		effectiveState: "open",
		canRespond: true,
	} as Row;
}

describe("projection and ranking", () => {
	it("projects ask fields and ranks overdue, then soonest deadline, first", () => {
		const cards = projectDeckCards({
			requests: [
				row("later", { riskLevel: "critical" }, "2026-10-20T18:00:00.000Z"),
				row("late", { riskLevel: "critical" }, "2026-10-19T09:00:00.000Z"),
				row("latest", { riskLevel: "critical" }, "2026-10-18T09:00:00.000Z"),
				row("send", {
					schema: "tedix.outbound.v1",
					outboundStatus: "waiting_on_you",
				}),
			],
			work: [],
			runtime: [],
			now,
			timeZone: "Europe/Berlin",
			staleDraftHours: 24,
		});
		expect(cards.map((card) => card.id).slice(0, 2)).toEqual([
			"latest",
			"late",
		]);
		expect(cards[0]).toMatchObject({
			askKind: "answer",
			deadline: "2026-10-18T09:00:00.000Z",
			overdue: true,
			draftedNotSent: false,
		});
		expect(cards.find((card) => card.id === "send")).toMatchObject({
			askKind: "send",
			overdue: false,
			draftedNotSent: true,
		});
		expect(cards.find((card) => card.id === "later")?.overdue).toBe(false);
	});

	it("shows handled and expired asks as such, never overdue, and ranks them last", () => {
		const handled = row("handled", {}, "2026-10-18T09:00:00.000Z");
		handled.workItem = {
			id: "11111111-1111-4111-8111-111111111111",
			title: "Fictional filing",
			projectId: null,
			disposition: "completed",
		};
		const expired = row(
			"expired",
			{
				decisionDeck: envelope("decision", {
					expiresAt: "2026-10-19T08:00:00.000Z",
				}),
			},
			"2026-10-18T09:00:00.000Z",
		);
		const late = row("late", {}, "2026-10-19T09:00:00.000Z");
		const cards = projectDeckCards({
			requests: [handled, expired, late],
			destination: "all",
			work: [],
			runtime: [],
			now,
			timeZone: "Europe/Berlin",
		});
		expect(cards.map((card) => card.id)).toEqual([
			"late",
			"handled",
			"expired",
		]);
		expect(cards[0]).toMatchObject({ overdue: true });
		expect(cards[1]).toMatchObject({ overdue: false, handled: true });
		expect(cards[2]).toMatchObject({ overdue: false, expired: true });
		const text = attentionMarkdown(
			cards.map((card, index) => deckDisplayCard(card, index)),
			true,
		);
		expect(text).toContain("Handled");
		expect(text).toContain("Expired");
		expect(text.match(/Overdue/g)).toHaveLength(1);
	});

	it("keeps a credential ask on the Deck when generated copy marks its effect unknown", () => {
		const ask = row("credential", {
			cardPresentation: {
				version: 2,
				title: "Connect the coding agent?",
				body: "Unknown",
				recommendation: "Unknown",
				effectStatus: "unknown",
			},
		});
		ask.request.subject = "Add the GitHub token for the coding agent";
		ask.request.prompt =
			"Paste a GitHub personal access token in connection settings.";
		const cards = projectDeckCards({
			requests: [ask],
			work: [],
			runtime: [],
			now,
		});
		expect(cards.map((card) => card.id)).toEqual(["credential"]);
	});

	it("uses the decision deadline when the request has none", () => {
		expect(
			compareDecisionFreshness(
				{ deadline: "2026-10-19T00:00:00.000Z", score: 0 },
				{ score: 100 },
				now,
			),
		).toBeLessThan(0);
	});

	it("keeps overdue cards ahead of critical ones in the curated order", () => {
		expect(
			orderCuratedDeck(
				[
					{ id: "critical", score: 10 },
					{ id: "overdue", score: 0, overdue: true },
				],
				[],
				new Set(["critical"]),
			).map((card) => card.id),
		).toEqual(["overdue", "critical"]);
	});

	it("carries ask label, overdue and drafted-not-sent into the MCP card and text fallback", () => {
		const [card] = projectDeckCards({
			requests: [
				row(
					"send",
					{ schema: "tedix.outbound.v1", outboundStatus: "waiting_on_you" },
					"2026-10-19T09:00:00.000Z",
				),
			],
			work: [],
			runtime: [],
			now,
			timeZone: "Europe/Berlin",
		});
		const view = deckDisplayCard(card!, 0);
		expect(view).toMatchObject({
			askKind: "send",
			askLabel: "Send",
			overdue: true,
			draftedNotSent: true,
			dueAt: "2026-10-19T09:00:00.000Z",
		});
		const markdown = attentionMarkdown([view], true);
		expect(markdown).toContain("Drafted, not sent: 1 message draft waiting");
		expect(markdown).toContain(
			"[Send · Overdue · Drafted, not sent · due 2026-10-19 09:00]",
		);
	});
});

describe("retired cards", () => {
	it("show in the Feed as handled updates for a day, linking the evidence", () => {
		const retired = (id: string, resolvedAt: string) => {
			const r = row(id, {
				curation: {
					schema: "tedix.deck-curation.v1",
					revision: 2,
					draftBody: null,
					status: "cancelled",
					successorId: null,
					penalty: 0,
					reason: "Booth tasks were done on site",
					evidenceRefs: ["https://example.test/work/items/booth"],
					model: null,
					exampleIds: [],
					retirement: { reason: "handled_elsewhere", workItemId: null },
				},
			});
			r.effectiveState = "cancelled";
			r.request.resolvedAt = resolvedAt;
			return r;
		};
		const items = retiredDeckFeedItems(
			[
				retired("today", "2026-10-20T10:00:00.000Z"),
				retired("old", "2026-10-18T10:00:00.000Z"),
				row("open", {}),
			],
			now,
		);
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			id: "retired:today",
			done: true,
			needsAction: false,
			source: "https://example.test/work/items/booth",
			sentence: "Retired (handled elsewhere): Fictional card today?",
		});
	});
});
