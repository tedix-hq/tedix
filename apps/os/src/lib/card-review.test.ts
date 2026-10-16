import { describe, expect, it } from "vite-plus/test";
import type { CardReviewSource } from "@tedix/api-contract/schemas/os-card-review";
import {
	cardReviewConfigFromManifest,
	cardsFromSheet,
	columnIndex,
	doItLabel,
	firstLink,
	formatReason,
	isSnoozed,
	pendingRules,
	plainWhy,
	type ReviewCard,
	reviewQueue,
	rowWrite,
	ruleTextById,
	snoozeUntil,
	sourceParts,
	verdictCells,
} from "./card-review";

const INBOX_WS = "11111111-1111-4111-8111-111111111111";
const SOCIAL_WS = "22222222-2222-4222-8222-222222222222";

const inbox: CardReviewSource = {
	label: "Inbox",
	workspaceId: INBOX_WS,
	cardSheetPrefix: "Inbox cards ",
	maxRuns: 3,
	columns: {
		number: "#",
		type: "Card type",
		source: "Thread",
		action: "Proposed action",
		why: "Why",
		draft: "Draft",
		useful: "Useful?",
		reason: "Reason",
		done: "Approve action?",
	},
	doIt: "approve",
	rules: {
		sheetTitle: "Rules",
		idColumn: "Rule id",
		textColumn: "Rule",
		statusColumn: "Status",
	},
};

const social: CardReviewSource = {
	label: "Social",
	workspaceId: SOCIAL_WS,
	cardSheetPrefix: "Social cards ",
	maxRuns: 3,
	columns: {
		source: "Source (link)",
		who: "Who",
		why: "Why (rule)",
		draft: "Draft",
		useful: "Useful?",
		reason: "Reason",
		done: "Did it?",
	},
	doIt: "copy_and_open",
	channels: [
		{ label: "LinkedIn", match: ["linkedin.com"] },
		{ label: "X", match: ["x.com", "twitter.com"] },
	],
};

const inboxColumns = [
	"#",
	"Card type",
	"Thread (sender · subject · Gmail link)",
	"Proposed action",
	"Why (rule / reasoning)",
	"Draft",
	"Useful?",
	"Reason",
	"Approve action?",
];

describe("cardReviewConfigFromManifest", () => {
	it("ignores other apps and explains invalid settings", () => {
		expect(
			cardReviewConfigFromManifest({ capabilities: [], entry: "main.tsx" }),
		).toEqual({ kind: "none" });
		const invalid = cardReviewConfigFromManifest({
			capabilities: [],
			entry: "tedix:app/card-review",
			config: { version: 1, sources: [{ label: "Inbox" }] },
		});
		expect(invalid.kind).toBe("invalid");
		expect(invalid.kind === "invalid" && invalid.message).toMatch(
			/^sources\.0\./,
		);
	});

	it("accepts a two-source config and applies defaults", () => {
		const { maxRuns: _a, ...inboxInput } = inbox;
		const result = cardReviewConfigFromManifest({
			capabilities: [],
			entry: "tedix:app/card-review",
			config: { version: 1, sources: [inboxInput, social] },
		});
		expect(result.kind).toBe("ok");
		expect(result.kind === "ok" && result.config.sources[0]?.maxRuns).toBe(3);
	});
});

describe("columns and links", () => {
	it("prefers an exact header and falls back to a prefix", () => {
		expect(columnIndex(inboxColumns, "thread")).toBe(2);
		expect(columnIndex(["Why", "Why (rule)"], "why")).toBe(0);
		expect(columnIndex(inboxColumns, "Missing")).toBe(-1);
	});

	it("finds the first link without trailing punctuation", () => {
		expect(firstLink("Ada Example · Hello · https://example.com/a.")).toBe(
			"https://example.com/a",
		);
		expect(firstLink("no link")).toBeNull();
	});

	it("splits a source cell into readable text and every link", () => {
		expect(
			sourceParts(
				"Ada Example · 'Hello' + 'Again' · https://example.com/a; https://example.com/b.",
			),
		).toEqual({
			label: "Ada Example · 'Hello' + 'Again'",
			links: ["https://example.com/a", "https://example.com/b"],
		});
		expect(sourceParts("plain")).toEqual({ label: "plain", links: [] });
	});
});

describe("cardsFromSheet", () => {
	it("builds cards, skips blank rows and cites rules", () => {
		const result = cardsFromSheet({
			source: social,
			sourceIndex: 1,
			outputId: "sheet-1",
			sheetTitle: "Social cards 2026-01-02 08:00",
			runCreatedAt: "2026-01-02T08:00:00.000Z",
			body: {
				columns: [
					"#",
					"Type",
					"Source (link)",
					"Who",
					"Why (rule)",
					"Draft",
					"Useful?",
					"Reason",
					"Did it?",
				],
				rows: [
					[
						1,
						"reply",
						"https://www.linkedin.com/feed/1",
						"Ada Example",
						"R2: asked a direct question",
						"Thanks, Ada!",
						"",
						"",
						"",
					],
					[null, "", "", "", "", "", null, null, null],
					[
						null,
						"comment",
						"https://x.com/example/status/1",
						"Bo Sample",
						"R4, R6: fresh topic",
						"",
						"yes",
						"",
						"",
					],
				],
			},
		});
		expect("cards" in result).toBe(true);
		if (!("cards" in result)) return;
		expect(result.cards).toHaveLength(2);
		expect(result.cards[0]).toMatchObject({
			channel: "LinkedIn",
			link: "https://www.linkedin.com/feed/1",
			ruleIds: ["R2"],
			number: "1",
			rowIndex: 0,
		});
		expect(result.cards[1]).toMatchObject({
			channel: "X",
			ruleIds: ["R4", "R6"],
			number: "3",
			useful: "yes",
		});
	});

	it("reports required columns the sheet lacks", () => {
		const result = cardsFromSheet({
			source: inbox,
			sourceIndex: 0,
			outputId: "sheet-2",
			sheetTitle: "Inbox cards old",
			runCreatedAt: "2026-01-01T00:00:00.000Z",
			body: { columns: ["#", "Thread", "Why"], rows: [] },
		});
		expect(result).toEqual({
			missing: {
				sheetTitle: "Inbox cards old",
				missing: ["Useful?", "Reason", "Approve action?"],
			},
		});
	});
});

function card(overrides: Partial<ReviewCard>): ReviewCard {
	return {
		key: "a:0",
		sourceIndex: 0,
		sourceLabel: "Inbox",
		channel: "Inbox",
		outputId: "a",
		sheetTitle: "Inbox cards",
		runCreatedAt: "2026-01-01T00:00:00.000Z",
		rowIndex: 0,
		number: "1",
		type: "",
		sourceText: "",
		link: null,
		who: "",
		why: "",
		ruleIds: [],
		action: "",
		draft: "",
		useful: "",
		reason: "",
		done: "",
		...overrides,
	};
}

describe("reviewQueue", () => {
	const now = new Date("2026-01-03T12:00:00.000Z");
	const cards = [
		card({ key: "old:0", outputId: "old", rowIndex: 0 }),
		card({
			key: "new:1",
			outputId: "new",
			rowIndex: 1,
			runCreatedAt: "2026-01-02T00:00:00.000Z",
		}),
		card({
			key: "new:0",
			outputId: "new",
			rowIndex: 0,
			runCreatedAt: "2026-01-02T00:00:00.000Z",
		}),
		card({ key: "done:0", outputId: "done", useful: "no" }),
		card({ key: "x:0", outputId: "x", channel: "X" }),
	];

	it("orders newest run first, then sheet order, without answered cards", () => {
		expect(
			reviewQueue(cards, { channel: null, snoozes: {}, skipped: [], now }).map(
				(c) => c.key,
			),
		).toEqual(["new:0", "new:1", "old:0", "x:0"]);
		const later = card({
			key: "second:0",
			outputId: "second",
			sourceIndex: 1,
			runCreatedAt: "2026-01-09T00:00:00.000Z",
		});
		expect(
			reviewQueue([later, ...cards], {
				channel: null,
				snoozes: {},
				skipped: [],
				now,
			}).at(-1)?.key,
		).toBe("second:0");
	});

	it("filters by channel, hides snoozed cards and moves skipped ones last", () => {
		expect(
			reviewQueue(cards, { channel: "X", snoozes: {}, skipped: [], now }),
		).toHaveLength(1);
		const queue = reviewQueue(cards, {
			channel: "Inbox",
			snoozes: {
				"old:0": "2026-01-04T00:00:00.000Z",
				"new:1": "2026-01-01T00:00:00.000Z",
			},
			skipped: ["new:0"],
			now,
		});
		expect(queue.map((c) => c.key)).toEqual(["new:1", "new:0"]);
	});

	it("snoozes until the next local midnight", () => {
		const until = new Date(snoozeUntil(new Date(2026, 0, 3, 15, 30)));
		expect(until.getDate()).toBe(4);
		expect(until.getHours()).toBe(0);
		expect(isSnoozed({ k: until.toISOString() }, "k", now)).toBe(true);
		expect(isSnoozed({}, "k", now)).toBe(false);
	});
});

describe("verdicts", () => {
	it("writes one consistent reason form", () => {
		expect(formatReason(["Wrong person", "Not timely"], "  event  over ")).toBe(
			"Wrong person, Not timely: event over",
		);
		expect(formatReason(["Great angle"], "")).toBe("Great angle");
		expect(formatReason([], "just text")).toBe("just text");
	});

	it("maps each verdict to its cells", () => {
		expect(
			verdictCells(inbox, { useful: "" }, { kind: "useful", reason: "r" }),
		).toEqual({ "Useful?": "yes", Reason: "r" });
		expect(
			verdictCells(inbox, { useful: "" }, { kind: "not_useful", reason: "" }),
		).toEqual({ "Useful?": "no", Reason: "", "Approve action?": "no" });
		expect(
			verdictCells(social, { useful: "no" }, { kind: "do_it", reason: "" }),
		).toEqual({ "Useful?": "no", Reason: "", "Did it?": "yes" });
		expect(
			verdictCells(social, { useful: "" }, { kind: "do_it", reason: "" }),
		).toMatchObject({ "Useful?": "yes", "Did it?": "yes" });
	});

	it("writes one rectangle that keeps cells between the written columns", () => {
		const body = {
			columns: ["A", "Useful?", "Note", "Reason"],
			rows: [["a", null, "keep me", null]],
		};
		expect(rowWrite(body, 0, { Reason: "r", "Useful?": "yes" })).toEqual({
			startColumn: 1,
			cells: [["yes", "keep me", "r"]],
		});
		expect(() => rowWrite(body, 0, { Missing: "x" })).toThrow();
	});
});

describe("rules", () => {
	const body = {
		columns: ["Rule id", "Rule", "Source", "Date", "Status"],
		rows: [
			["R1", "Seed rule", "seed", "2026-01-01", "seed"],
			["R2", "Proposed rule", "factory", "2026-01-02", "Proposed"],
		],
	};

	it("offers only proposed rows", () => {
		expect(
			pendingRules({ source: inbox, sourceIndex: 0, outputId: "rules", body }),
		).toEqual([
			{
				key: "rules:1",
				sourceIndex: 0,
				sourceLabel: "Inbox",
				outputId: "rules",
				rowIndex: 1,
				id: "R2",
				text: "Proposed rule",
			},
		]);
		expect(
			pendingRules({ source: social, sourceIndex: 1, outputId: "r", body }),
		).toEqual([]);
	});

	it("maps rule ids to their text", () => {
		expect(ruleTextById(inbox, body).get("R1")).toBe("Seed rule");
	});
});

describe("plain card text", () => {
	it("drops rule ids from the why text", () => {
		expect(plainWhy("R7: group mail, so archive.")).toBe(
			"Group mail, so archive.",
		);
		expect(plainWhy("Mia asked if Tuesday works. (R4, R10)")).toBe(
			"Mia asked if Tuesday works.",
		);
	});

	it("names Do it after a short action and hides it without one", () => {
		const approve = { doIt: "approve" as const };
		expect(doItLabel(approve, { action: "Draft a reply to Mia" })).toBe(
			"Draft a reply to Mia",
		);
		expect(doItLabel(approve, { action: "" })).toBeNull();
		expect(doItLabel(approve, { action: null })).toBe("Do it");
		expect(
			doItLabel(
				{ doIt: "copy_and_open" },
				{ action: "Decide whether you go tomorrow and bring your photo ID" },
			),
		).toBe("Copy draft and open");
	});
});
