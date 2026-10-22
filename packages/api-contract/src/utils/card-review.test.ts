import { describe, expect, it } from "vite-plus/test";
import {
	firstLink,
	sourceParts,
	cardsFromSheet,
	reviewQueue,
} from "./card-review";
import { factoryCardDeadline } from "./card-schedule";
import { CardReviewSourceSchema } from "../schemas/os-card-review";

/**
 * A cell that counts how many characters the scan reads, so linear-time
 * behaviour can be checked without a wall-clock threshold.
 */
function countedCell(text: string): { cell: string; reads: () => number } {
	let reads = 0;
	const cell = new Proxy(new String(text), {
		get(target, property, receiver) {
			if (typeof property === "string" && /^\d+$/.test(property)) reads += 1;
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return { cell: cell as unknown as string, reads: () => reads };
}

describe("firstLink", () => {
	it("returns the first link without trailing punctuation", () => {
		expect(firstLink("Ada Example · Hello · https://example.com/a.")).toBe(
			"https://example.com/a",
		);
		expect(firstLink("see http://a.test/x, then https://b.test/y")).toBe(
			"http://a.test/x",
		);
		expect(firstLink("no link")).toBeNull();
		expect(firstLink("http://")).toBeNull();
	});
});

describe("sourceParts", () => {
	it("splits a source cell into readable text and its links", () => {
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

	it("keeps at most three de-duplicated links", () => {
		expect(
			sourceParts(
				"https://a.test/1 https://a.test/1 https://b.test/2 https://c.test/3 https://d.test/4",
			).links,
		).toEqual(["https://a.test/1", "https://b.test/2", "https://c.test/3"]);
	});

	it("removes links from the label text", () => {
		expect(sourceParts("Title (https://x.test/p)")).toEqual({
			label: "Title",
			links: ["https://x.test/p"],
		});
	});

	it("handles a 50k-character link cell in linear time", () => {
		const run = (length: number) => {
			const { cell, reads } = countedCell(`http://${"a".repeat(length)}.`);
			const link = firstLink(cell);
			const parts = sourceParts(cell);
			return { link, parts, reads: reads() };
		};
		const small = run(10_000);
		const large = run(50_000);
		// A wall-clock threshold flakes under CI load; a linear scan instead
		// reads each character a bounded number of times, so 5x the input must
		// cost about 5x the reads.
		expect(large.reads).toBeLessThanOrEqual(small.reads * 6);
		expect(large.link?.length).toBeLessThanOrEqual(2_048);
		expect(large.parts.links).toEqual([large.link]);
		expect(large.parts.label).toBe("");
	});
});

it("preserves deadline and visibility column meanings through the review queue", () => {
	const source = CardReviewSourceSchema.parse({
		label: "Pine",
		workspaceId: "11111111-1111-4111-8111-111111111111",
		cardSheetPrefix: "Cards",
		columns: {
			source: "Source",
			why: "Why",
			useful: "Useful",
			reason: "Reason",
			done: "Done",
		},
		doIt: "approve",
	});
	const parsed = cardsFromSheet({
		source,
		sourceIndex: 0,
		outputId: "fictional-sheet",
		sheetTitle: "Cards",
		runCreatedAt: "2026-10-20T12:00:00Z",
		body: {
			kind: "sheet",
			columns: [
				"Source",
				"Why",
				"Useful",
				"Reason",
				"Done",
				"Due",
				"Show from",
			],
			rows: [
				["Visible", "Review", "", "", "", "2026-10-22", ""],
				["Hidden", "Wait", "", "", "", "2026-10-22", "2026-10-21"],
			],
		},
	});
	if ("missing" in parsed) throw new Error("Missing fixture columns");
	const options = {
		channel: null,
		snoozes: {},
		skipped: [],
		timeZone: "Europe/Berlin",
		now: new Date("2026-10-20T12:00:00Z"),
	};
	expect(
		reviewQueue(parsed.cards, options).map((card) => card.sourceText),
	).toEqual(["Visible"]);
	expect(
		reviewQueue(parsed.cards, {
			...options,
			now: new Date("2026-10-20T22:00:00Z"),
		}),
	).toHaveLength(2);
	expect(parsed.cards.map((card) => factoryCardDeadline(card))).toEqual([
		"2026-10-22",
		"2026-10-22",
	]);
});
