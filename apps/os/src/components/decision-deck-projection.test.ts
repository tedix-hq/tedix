import { describe, expect, it } from "vite-plus/test";
import { CardReviewSourceSchema } from "@tedix/api-contract/schemas/os-card-review";
import { DecisionDeckConfigSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import type { ReviewCard } from "@tedix/api-contract/utils/card-review";
import type { useDecisionInbox } from "@/lib/use-decision-inbox";
import { projectDecisionDeck } from "./decision-deck-projection";

const source = CardReviewSourceSchema.parse({
	label: "Social opportunities",
	workspaceId: "00000000-0000-4000-8000-000000000002",
	cardSheetPrefix: "Social cards",
	doIt: "approve",
	columns: {
		number: "#",
		type: "Type",
		source: "Source",
		who: "Who",
		why: "Why",
		useful: "Useful?",
		reason: "Reason",
		done: "Did it?",
		timing: "Timing",
	},
});

function card(key: string, proposal: string): ReviewCard {
	return {
		key,
		sourceIndex: 0,
		sourceLabel: "Social opportunities",
		channel: "Social",
		outputId: "00000000-0000-4000-8000-000000000003",
		sheetTitle: "Social cards today",
		runCreatedAt: "2026-10-17T09:00:00Z",
		rowIndex: 0,
		number: "1",
		type: "opportunity",
		sourceText: "https://example.com/post",
		link: "https://example.com/post",
		who: "",
		why: "R2: a good reason",
		ruleIds: [],
		action: proposal,
		draft: "",
		useful: "",
		reason: "",
		done: "",
		result: "",
		score: null,
		features: null,
		effort: "",
		timing: "Today",
	};
}

function decisions(
	factoryCards: ReviewCard[],
	factoryWaiting: ReviewCard[],
): ReturnType<typeof useDecisionInbox> {
	return {
		requests: [],
		work: [],
		factoryCards,
		factoryWaiting,
		approvals: { data: { data: [] } },
	} as unknown as ReturnType<typeof useDecisionInbox>;
}

const config = DecisionDeckConfigSchema.parse({
	version: 1,
	factorySources: [source],
});

describe("projectDecisionDeck waiting mode", () => {
	it("lists every open factory card, not only the deck-routed queue", () => {
		const deckCard = card("sheet:1", "Deck-routed proposal");
		const feedCard = card("sheet:2", "Feed-routed proposal");
		const inbox = decisions([deckCard], [deckCard, feedCard]);
		const now = new Date("2026-10-17T12:00:00Z");
		const waiting = projectDecisionDeck({
			config,
			mode: "waiting",
			decisions: inbox,
			history: [],
			learningModel: undefined,
			now,
			timeZone: undefined,
		});
		expect(waiting.rows.map((row) => row.id)).toEqual([
			"factory:sheet:1",
			"factory:sheet:2",
		]);
		const second = waiting.rows[1]!;
		expect(second.label).toBe("Feed-routed proposal");
		expect(second.sourceLabel).toBe("Social opportunities");
		expect(second.costOfWaiting).toBe("Today");

		const decide = projectDecisionDeck({
			config,
			mode: "decide",
			decisions: inbox,
			history: [],
			learningModel: undefined,
			now,
			timeZone: undefined,
		});
		expect(decide.rows.map((row) => row.id)).toEqual(["factory:sheet:1"]);
	});
});

describe("projectDecisionDeck objective ranking", () => {
	const ask = (id: string, requestedAt: string, objective?: object) => ({
		request: {
			id,
			kind: "question",
			subject: `Ask ${id}`,
			prompt: "",
			metadata: {},
			requestedAt,
			dueAt: null,
			projectId: null,
		},
		workItem: null,
		effectiveState: "open",
		...(objective ? { objective } : {}),
	});

	it("weighs the objective a card serves: the top goal first, then any goal, then the rest", () => {
		const grow = {
			id: "grow",
			title: "Grow orchard sales",
			priority: 1,
			top: true,
		};
		const keep = {
			id: "keep",
			title: "Keep the cellar dry",
			priority: 2,
			top: false,
		};
		const inbox = {
			...decisions([], []),
			requests: [
				ask("newest", "2026-10-17T11:00:00Z"),
				ask("other-goal", "2026-10-17T10:00:00Z", keep),
				ask("top-goal", "2026-10-17T08:00:00Z", grow),
			],
		} as unknown as ReturnType<typeof useDecisionInbox>;
		const deck = projectDecisionDeck({
			config,
			mode: "decide",
			decisions: inbox,
			history: [],
			learningModel: undefined,
			now: new Date("2026-10-17T12:00:00Z"),
			timeZone: undefined,
		});
		const order = [...deck.rows].sort(deck.compare);
		expect(order.map((row) => row.id)).toEqual([
			"top-goal",
			"other-goal",
			"newest",
		]);
		expect(order[0]).toMatchObject({
			objective: grow,
			priority: { band: "week", reason: "Serves the top goal" },
		});
	});

	it("titles a stored deadline card with the task's own name", () => {
		const title =
			"Ada takes the orchard review live for Cedar, Birch and Maple with daily checks";
		const stored = {
			...ask("deadline", "2026-10-17T11:00:00Z"),
			workItem: { id: "work", title, projectId: null },
		};
		stored.request.subject = `Review ${title.slice(0, 70)}?`;
		stored.request.metadata = { source: "deadline-decisions" };
		const deck = projectDecisionDeck({
			config,
			mode: "decide",
			decisions: {
				...decisions([], []),
				requests: [stored],
			} as unknown as ReturnType<typeof useDecisionInbox>,
			history: [],
			learningModel: undefined,
			now: new Date("2026-10-17T12:00:00Z"),
			timeZone: undefined,
		});
		expect(deck.rows[0]?.label).toBe(title);
	});
});
