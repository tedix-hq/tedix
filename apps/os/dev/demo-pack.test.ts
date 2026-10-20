// @vitest-environment node
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import {
	DeckProjectionSchema,
	DeckCardSchema,
} from "@tedix/api-contract/schemas/attention";
import { DEMO_SENDING_OFF_MESSAGE } from "@tedix/api-contract/utils/demo-sending-gate";
import {
	DEMO_PACK_MAX_AGE_MS,
	demoPackCards,
	demoPackIsStale,
	shiftDemoDates,
} from "./demo-pack";
import {
	enableDemoPack,
	handleLocalRpc,
	isDemoPackEnabled,
	resetLocalFixtures,
} from "./local-fixtures";

const rpc = (key: string, input: unknown = {}) =>
	handleLocalRpc(`/api/rpc/${key}`, "POST", { json: input })!;
const ok = <T>(key: string, input: unknown = {}): T => {
	const result = rpc(key, input);
	expect(result.status).toBe(200);
	return (result.body as { json: T }).json;
};

describe("shiftDemoDates", () => {
	const anchor = "2026-10-20T12:00:00.000Z";

	it("moves every instant by the distance from the anchor to now and leaves other text alone", () => {
		const now = Date.parse("2026-11-03T09:30:00.000Z");
		const shifted = shiftDemoDates(
			{
				at: "2026-10-20T11:58:53.852735Z",
				nested: [{ when: anchor }],
				deadline: "Today, 14:00",
				day: 2,
			},
			anchor,
			now,
		);
		expect(shifted.nested[0]!.when).toBe(new Date(now).toISOString());
		expect(Date.parse(shifted.at)).toBe(
			now - (Date.parse(anchor) - Date.parse("2026-10-20T11:58:53.852Z")),
		);
		expect(shifted.deadline).toBe("Today, 14:00");
		expect(shifted.day).toBe(2);
	});

	it("rebuilds only after a week", () => {
		const built = Date.parse("2026-10-20T12:00:00.000Z");
		expect(demoPackIsStale(built, built + DEMO_PACK_MAX_AGE_MS)).toBe(false);
		expect(demoPackIsStale(built, built + DEMO_PACK_MAX_AGE_MS + 1)).toBe(true);
	});

	it("dates cards relative to now, with history on earlier days", () => {
		const now = Date.parse("2027-02-01T10:00:00.000Z");
		const cards = demoPackCards(now);
		for (const { card, requestedAt } of cards) {
			const age = now - Date.parse(requestedAt);
			expect(age).toBeGreaterThan(0);
			expect(Math.floor(age / 86_400_000)).toBe(card.day);
		}
	});
});

describe("sample company in fixture mode", () => {
	beforeAll(() => {
		enableDemoPack();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("serves a non-empty Deck that satisfies the contract", () => {
		expect(isDemoPackEnabled()).toBe(true);
		const deck = DeckProjectionSchema.parse(ok("attention/listDeckCards"));
		expect(deck.cards.length).toBeGreaterThanOrEqual(20);
		expect(deck.count).toBe(deck.cards.length);
		const reddit = deck.cards.filter((card) =>
			card.decision?.classId.startsWith("reddit."),
		);
		expect(reddit).toHaveLength(20);
		expect(
			new Set(deck.cards.map((card) => card.decision?.classId.split(".")[0])),
		).toEqual(new Set(["reddit", "finance", "incident"]));
		for (const card of deck.cards) DeckCardSchema.parse(card);
	});

	it("installs Feed and Deck so Work no longer asks to set them up", () => {
		const apps = ok<{ items: { gadget: { name: string } }[] }>(
			"osWorkspaces/gadgets/workApps",
			{ limit: 20 },
		);
		expect(apps.items.map((item) => item.gadget.name).sort()).toEqual([
			"Deck",
			"Feed",
		]);
		const feed = ok<{ events: { createdAt: string }[] }>(
			"workItems/listActivity",
		);
		expect(feed.events.length).toBeGreaterThan(0);
		for (const event of feed.events)
			expect(Date.parse(event.createdAt)).toBeLessThanOrEqual(Date.now());
	});

	it("keeps decided history out of the Deck but in the inbox history", () => {
		const open = ok<{ data: unknown[] }>("workInteractions/listInbox", {
			states: ["open"],
		});
		const resolved = ok<{ data: unknown[] }>("workInteractions/listInbox", {
			states: ["resolved"],
		});
		expect(open.data.length).toBe(36);
		expect(resolved.data.length).toBe(50);
	});

	it("carries tedis, workspaces and memory facts", () => {
		expect(
			ok<{ data: { name: string }[] }>("tedis/list", { limit: 20 }).data.map(
				(tedi) => tedi.name,
			),
		).toEqual(["Reddit Scout", "Reply Writer", "Reconciler", "On-call"]);
		expect(
			ok<{ entries: { title: string }[] }>("skills/listByOrg").entries,
		).toHaveLength(4);
		const facts = ok<{ lessons: unknown[] }>("agentTurnTriage/listLessons");
		expect(facts.lessons.length).toBeGreaterThanOrEqual(5);
	});

	it("answers a card and removes it from the Deck", () => {
		const before = DeckProjectionSchema.parse(ok("attention/listDeckCards"));
		const card = before.cards[0]!;
		ok("workInteractions/respond", {
			requestId: card.id,
			expectedRequestVersion: card.interaction!.request.version,
			responseKind: "answer",
			body: "Useful",
			resolvesRequest: true,
		});
		const after = DeckProjectionSchema.parse(ok("attention/listDeckCards"));
		expect(after.count).toBe(before.count - 1);
		resetLocalFixtures();
		expect(
			DeckProjectionSchema.parse(ok("attention/listDeckCards")).count,
		).toBe(before.count);
	});

	it("rebuilds a pack older than a week so it reads as today again", () => {
		const first = DeckProjectionSchema.parse(ok("attention/listDeckCards"));
		vi.useFakeTimers({ now: Date.now() + 8 * 86_400_000 });
		const later = DeckProjectionSchema.parse(ok("attention/listDeckCards"));
		const newest = Math.max(
			...later.cards.map((card) => Date.parse(card.requestedAt)),
		);
		expect(newest).toBeGreaterThan(Date.now() - 86_400_000);
		expect(later.count).toBe(first.count);
	});
});

describe("sending is switched off", () => {
	beforeAll(() => {
		enableDemoPack();
	});

	const forbidden = (key: string, input: unknown) => {
		const result = rpc(key, input);
		expect(result.status).toBe(403);
		expect(result.body).toMatchObject({
			json: { code: "FORBIDDEN", message: DEMO_SENDING_OFF_MESSAGE },
		});
	};

	it("refuses to send or approve an outbound draft", () => {
		forbidden("workInteractions/outbound/act", {
			action: "approve_send",
			workItemId: "00000090-0000-4000-8000-000000000001",
			expectedVersion: 1,
		});
		forbidden("workInteractions/outbound/submit", {});
	});

	it("refuses email even where the fixture has no handler", () => {
		forbidden("tediEmail/sendEmail", { to: "someone@example.test" });
		forbidden("tediEmail/replyEmail", {});
	});

	it("refuses to schedule a card or a workspace skill", () => {
		forbidden("workInteractions/respond", {
			requestId: "000000a7-0000-4000-8000-000000000001",
			scheduledFor: "2030-01-01T09:00:00Z",
		});
		forbidden("osWorkspaces/schedules/allowPersonalRead", {});
	});

	it("still lets a person review a draft locally", () => {
		expect(rpc("workInteractions/outbound/list", {}).status).toBe(200);
	});
});
