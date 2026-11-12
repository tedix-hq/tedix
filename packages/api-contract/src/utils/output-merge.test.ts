import { describe, expect, it } from "vite-plus/test";
import type {
	OsOutputContent,
	OsRichTextNode,
	OsWorkbookCell,
} from "../schemas/os-workspaces";
import { blocksFromRichText } from "./os-document";
import {
	mergeOutputContent as mergeWith,
	type OutputMergePreference,
} from "./output-merge";
import { projectPresentationDeck } from "./presentation-patch";

const mergeOutputContent = (
	base: OsOutputContent,
	mine: OsOutputContent,
	theirs: OsOutputContent,
	prefer?: OutputMergePreference,
) =>
	mergeWith(base, mine, theirs, {
		prefer,
		documentBlocks: blocksFromRichText,
		presentationSlides: projectPresentationDeck,
	});

type Sheet = Extract<OsOutputContent, { kind: "sheet" }>;
type Deck = Extract<OsOutputContent, { kind: "presentation" }>;
type Doc = Extract<OsOutputContent, { kind: "document" }>;

const cell = (input: string): OsWorkbookCell => ({ input, value: input });

function sheet(rows: (string | null)[][], active = "s1"): Sheet {
	const workbookRows = rows.map((row) =>
		row.map((value) => (value === null ? null : cell(value))),
	);
	return {
		kind: "sheet",
		columns: ["A", "B", "C"],
		rows: rows.map((row) => row.map((value) => value)),
		workbook: {
			activeSheetId: active,
			sheets: [
				{
					id: "s1",
					name: "Sheet1",
					columns: ["A", "B", "C"].map((label) => ({
						id: label,
						label,
						width: 120,
					})),
					rows: workbookRows,
					frozenRows: 0,
					frozenColumns: 0,
				},
				{
					id: "s2",
					name: "Sheet2",
					columns: [{ id: "A", label: "A", width: 120 }],
					rows: [],
					frozenRows: 0,
					frozenColumns: 0,
				},
			],
		},
	};
}

function setCell(content: Sheet, row: number, column: number, input: string) {
	const next = structuredClone(content);
	next.workbook!.sheets[0]!.rows[row]![column] = cell(input);
	return next;
}

const grid = () =>
	sheet([
		["a", null, null],
		[null, null, null],
		[null, null, null],
		[null, null, null],
		[null, null, null],
	]);

function deck(slides: { id: string; title: string; body?: string }[]): Deck {
	return {
		kind: "presentation",
		slides: [],
		deck: {
			width: 1200,
			height: 675,
			activeSlideId: slides[0]!.id,
			slides: slides.map((slide) => ({
				id: slide.id,
				name: slide.title,
				layout: "blank",
				background: "#ffffff",
				elements: [
					{
						id: `${slide.id}-title`,
						type: "title",
						x: 10,
						y: 10,
						width: 500,
						height: 80,
						text: slide.title,
					},
					{
						id: `${slide.id}-body`,
						type: "bullet",
						x: 10,
						y: 100,
						width: 500,
						height: 300,
						text: slide.body ?? "",
					},
				],
			})),
		},
	};
}

const paragraph = (text: string): OsRichTextNode => ({
	type: "paragraph",
	content: [{ type: "text", text }],
});

function doc(texts: string[]): Doc {
	return {
		kind: "document",
		blocks: [],
		richText: { type: "doc", content: texts.map(paragraph) },
	};
}

function merged(result: ReturnType<typeof mergeOutputContent>) {
	if (!result.ok) throw new Error(`conflicts: ${result.conflicts.join(", ")}`);
	return result.content;
}

describe("mergeOutputContent: sheets", () => {
	it("keeps edits to different cells and refreshes the projection", () => {
		const base = grid();
		const mine = setCell(base, 0, 0, "mine");
		const theirs = setCell(base, 4, 2, "theirs");
		const result = merged(mergeOutputContent(base, mine, theirs)) as Sheet;
		const rows = result.workbook!.sheets[0]!.rows;
		expect(rows[0]![0]!.input).toBe("mine");
		expect(rows[4]![2]!.input).toBe("theirs");
		expect(result.rows[0]![0]).toBe("mine");
		expect(result.rows[4]![2]).toBe("theirs");
	});

	it("keeps edits to different cells of one row", () => {
		const base = grid();
		const result = merged(
			mergeOutputContent(
				base,
				setCell(base, 1, 0, "left"),
				setCell(base, 1, 1, "right"),
			),
		) as Sheet;
		const row = result.workbook!.sheets[0]!.rows[1]!;
		expect(row.map((value) => value?.input ?? null)).toEqual([
			"left",
			"right",
			null,
		]);
	});

	it("reports two different values in the same cell", () => {
		const base = grid();
		const result = mergeOutputContent(
			base,
			setCell(base, 2, 1, "x"),
			setCell(base, 2, 1, "y"),
		);
		expect(result.ok).toBe(false);
	});

	it("keeps a row added by one side next to a cell edit by the other", () => {
		const base = grid();
		const mine = structuredClone(base);
		mine.workbook!.sheets[0]!.rows.splice(1, 0, [cell("new"), null, null]);
		const theirs = setCell(base, 3, 1, "edit");
		const rows = (merged(mergeOutputContent(base, mine, theirs)) as Sheet)
			.workbook!.sheets[0]!.rows;
		expect(rows).toHaveLength(6);
		expect(rows[1]![0]!.input).toBe("new");
		expect(rows[4]![1]!.input).toBe("edit");
	});

	it("does not treat which sheet each person has open as a conflict", () => {
		const base = grid();
		const mine = setCell(base, 0, 1, "m");
		mine.workbook!.activeSheetId = "s2";
		const theirs = setCell(base, 0, 2, "t");
		const result = merged(mergeOutputContent(base, mine, theirs)) as Sheet;
		expect(result.workbook!.activeSheetId).toBe("s2");
	});
});

describe("mergeOutputContent: presentations", () => {
	const base = deck([
		{ id: "one", title: "One" },
		{ id: "two", title: "Two" },
	]);

	it("keeps edits to different slides and re-derives the outline", () => {
		const mine = structuredClone(base);
		mine.deck!.slides[0]!.elements[0]!.text = "One, edited";
		const theirs = structuredClone(base);
		theirs.deck!.slides[1]!.elements[1]!.text = "A point";
		const result = merged(mergeOutputContent(base, mine, theirs)) as Deck;
		expect(result.slides.map((slide) => slide.title)).toEqual([
			"One, edited",
			"Two",
		]);
		expect(result.slides[1]!.bullets).toEqual(["A point"]);
	});

	it("keeps a slide added by each side", () => {
		const add = (title: string) => {
			const next = structuredClone(base);
			next.deck!.slides.push(deck([{ id: title, title }]).deck!.slides[0]!);
			return next;
		};
		const result = merged(
			mergeOutputContent(base, add("mine"), add("theirs")),
		) as Deck;
		expect(result.deck!.slides.map((slide) => slide.id)).toEqual([
			"one",
			"two",
			"theirs",
			"mine",
		]);
	});

	it("keeps a reorder next to an edit", () => {
		const mine = structuredClone(base);
		mine.deck!.slides.reverse();
		const theirs = structuredClone(base);
		theirs.deck!.slides[0]!.background = "#000000";
		const result = merged(mergeOutputContent(base, mine, theirs)) as Deck;
		expect(result.deck!.slides.map((slide) => slide.id)).toEqual([
			"two",
			"one",
		]);
		expect(result.deck!.slides[1]!.background).toBe("#000000");
	});

	it("refuses to drop a slide the other person edited", () => {
		const mine = structuredClone(base);
		mine.deck!.slides.splice(1, 1);
		const theirs = structuredClone(base);
		theirs.deck!.slides[1]!.elements[0]!.text = "Two, edited";
		expect(mergeOutputContent(base, mine, theirs).ok).toBe(false);
	});

	it("reports two edits to the same element field", () => {
		const mine = structuredClone(base);
		mine.deck!.slides[0]!.elements[0]!.text = "A";
		const theirs = structuredClone(base);
		theirs.deck!.slides[0]!.elements[0]!.text = "B";
		expect(mergeOutputContent(base, mine, theirs).ok).toBe(false);
	});
});

describe("mergeOutputContent: documents", () => {
	const base = doc(["first", "second", "third", "fourth"]);
	const texts = (content: OsOutputContent) =>
		(content as Doc).richText!.content.map(
			(node) => node.content?.[0]?.text ?? "",
		);

	it("keeps edits to different paragraphs and rebuilds blocks", () => {
		const mine = doc(["first, mine", "second", "third", "fourth"]);
		const theirs = doc(["first", "second", "third, theirs", "fourth"]);
		const result = merged(mergeOutputContent(base, mine, theirs)) as Doc;
		expect(texts(result)).toEqual([
			"first, mine",
			"second",
			"third, theirs",
			"fourth",
		]);
		expect(result.blocks.length).toBe(4);
	});

	it("keeps an insert and a delete in different places", () => {
		const mine = doc(["first", "new", "second", "third", "fourth"]);
		const theirs = doc(["first", "second", "third"]);
		expect(texts(merged(mergeOutputContent(base, mine, theirs)))).toEqual([
			"first",
			"new",
			"second",
			"third",
		]);
	});

	it("reports two edits to the same paragraph", () => {
		const mine = doc(["first", "second A", "third", "fourth"]);
		const theirs = doc(["first", "second B", "third", "fourth"]);
		expect(mergeOutputContent(base, mine, theirs).ok).toBe(false);
	});
});

describe("mergeOutputContent: one paragraph, word by word", () => {
	const line = (...content: OsRichTextNode[]): Doc => ({
		kind: "document",
		blocks: [],
		richText: { type: "doc", content: [{ type: "paragraph", content }] },
	});
	const t = (text: string, ...marks: string[]): OsRichTextNode => ({
		type: "text",
		text,
		...(marks.length ? { marks: marks.map((type) => ({ type })) } : {}),
	});
	const runs = (content: OsOutputContent) =>
		(content as Doc).richText!.content[0]!.content!;
	const base = line(t("The launch is on Monday and the owner is Ada."));

	it("keeps both changes when they touch different words", () => {
		const mine = line(t("The launch is on Friday and the owner is Ada."));
		const theirs = line(t("The launch is on Monday and the owner is Bob."));
		const result = merged(mergeOutputContent(base, mine, theirs)) as Doc;
		expect(runs(result)).toEqual([
			t("The launch is on Friday and the owner is Bob."),
		]);
		expect(result.blocks).toEqual([
			{
				type: "paragraph",
				text: "The launch is on Friday and the owner is Bob.",
			},
		]);
	});

	it("keeps words one added and words the other removed", () => {
		const mine = line(
			t("The public launch is on Monday and the owner is Ada."),
		);
		const theirs = line(t("The launch is on Monday."));
		expect(runs(merged(mergeOutputContent(base, mine, theirs)))).toEqual([
			t("The public launch is on Monday."),
		]);
	});

	it("asks when both changed the same word", () => {
		const mine = line(t("The launch is on Friday and the owner is Ada."));
		const theirs = line(t("The launch is on Sunday and the owner is Ada."));
		const result = mergeOutputContent(base, mine, theirs);
		expect(result.ok).toBe(false);
		expect(result.conflicts).toHaveLength(1);
	});

	it("asks when both typed at the same spot", () => {
		const mine = line(t("The launch is on Monday and the owner is Ada. Mine."));
		const theirs = line(
			t("The launch is on Monday and the owner is Ada. Theirs."),
		);
		expect(mergeOutputContent(base, mine, theirs).ok).toBe(false);
	});

	it("takes the chosen side only for the words both changed", () => {
		const mine = line(t("The launch is on Friday and the owner is Ada!"));
		const theirs = line(t("Our launch is on Sunday and the owner is Ada."));
		for (const [prefer, text] of [
			["mine", "Our launch is on Friday and the owner is Ada!"],
			["theirs", "Our launch is on Sunday and the owner is Ada!"],
		] as const) {
			const result = mergeOutputContent(base, mine, theirs, prefer);
			if (!result.ok) throw new Error("expected a merge");
			expect(runs(result.content)).toEqual([t(text)]);
			expect(result.conflicts).toHaveLength(1);
		}
	});

	it("keeps formatting one added next to a word the other changed", () => {
		const mine = line(
			t("The launch is on "),
			t("Monday", "bold"),
			t(" and the owner is Ada."),
		);
		const theirs = line(t("The launch is on Monday and the owner is Bob."));
		expect(runs(merged(mergeOutputContent(base, mine, theirs)))).toEqual([
			t("The launch is on "),
			t("Monday", "bold"),
			t(" and the owner is Bob."),
		]);
	});

	it("keeps existing formatting, links and line breaks around both changes", () => {
		const link: OsRichTextNode = {
			type: "text",
			text: "the plan",
			marks: [{ type: "link", attrs: { href: "https://example.com" } }],
		};
		const formatted = (first: string, last: string) =>
			line(
				t(`${first} `),
				t("important", "bold", "italic"),
				t(" note in "),
				link,
				{ type: "hardBreak" },
				t(`Second ${last}.`),
			);
		const result = merged(
			mergeOutputContent(
				formatted("An", "line"),
				formatted("One", "line"),
				formatted("An", "row"),
			),
		);
		expect(runs(result)).toEqual(runs(formatted("One", "row")));
	});

	it("asks when one changed a word the other reformatted", () => {
		const mine = line(
			t("The launch is on "),
			t("Monday", "bold"),
			t(" and the owner is Ada."),
		);
		const theirs = line(t("The launch is on Tuesday and the owner is Ada."));
		expect(mergeOutputContent(base, mine, theirs).ok).toBe(false);
	});

	it("merges inside a paragraph while other paragraphs change too", () => {
		const three = (a: string, b: string, c: string) => doc([a, b, c]);
		const result = merged(
			mergeOutputContent(
				three("one two three", "middle", "end"),
				three("one 2 three", "middle", "end, mine"),
				three("one two 3", "centre", "end"),
			),
		) as Doc;
		expect(
			result.richText!.content.map((node) => node.content![0]!.text),
		).toEqual(["one 2 3", "centre", "end, mine"]);
	});
});

describe("mergeOutputContent: identities", () => {
	const cases: OsOutputContent[] = [
		setCell(grid(), 1, 1, "x"),
		deck([{ id: "one", title: "Changed" }]),
		doc(["only"]),
	];
	const bases: OsOutputContent[] = [
		grid(),
		deck([{ id: "one", title: "One" }]),
		doc(["first", "second"]),
	];
	it("returns the changed side when the other side made no change", () => {
		cases.forEach((changed, index) => {
			const base = bases[index]!;
			const strip = (content: OsOutputContent) =>
				JSON.parse(JSON.stringify(content)) as OsOutputContent;
			const one = merged(mergeOutputContent(base, changed, base));
			const two = merged(mergeOutputContent(base, base, changed));
			expect(strip(one)).toEqual(strip(two));
		});
	});

	it("refuses mismatched kinds and videos", () => {
		expect(mergeOutputContent(grid(), doc(["a"]), grid()).ok).toBe(false);
	});
});

describe("mergeOutputContent: choosing a side for overlapping edits", () => {
	it("keeps every non-overlapping edit and takes the chosen side on the overlap", () => {
		const base = grid();
		const mine = setCell(setCell(base, 2, 1, "mine"), 0, 0, "only mine");
		const theirs = setCell(setCell(base, 2, 1, "theirs"), 4, 2, "only theirs");
		const keepMine = mergeOutputContent(base, mine, theirs, "mine");
		const keepTheirs = mergeOutputContent(base, mine, theirs, "theirs");
		const inputs = (result: typeof keepMine) => {
			if (!result.ok) throw new Error("expected a merge");
			const rows = (result.content as Sheet).workbook!.sheets[0]!.rows;
			return [rows[2]![1]!.input, rows[0]![0]!.input, rows[4]![2]!.input];
		};
		expect(inputs(keepMine)).toEqual(["mine", "only mine", "only theirs"]);
		expect(inputs(keepTheirs)).toEqual(["theirs", "only mine", "only theirs"]);
		expect(keepMine.conflicts.length).toBeGreaterThan(0);
	});

	it("keeps a slide the chosen side edited after the other deleted it", () => {
		const base = deck([
			{ id: "one", title: "One" },
			{ id: "two", title: "Two" },
			{ id: "three", title: "Three" },
		]);
		const mine = structuredClone(base);
		mine.deck!.slides.splice(1, 1);
		const theirs = structuredClone(base);
		theirs.deck!.slides[1]!.elements[0]!.text = "Two, edited";
		const kept = mergeOutputContent(base, mine, theirs, "theirs");
		if (!kept.ok) throw new Error("expected a merge");
		expect((kept.content as Deck).slides.map((slide) => slide.title)).toEqual([
			"One",
			"Two, edited",
			"Three",
		]);
		const dropped = mergeOutputContent(base, mine, theirs, "mine");
		if (!dropped.ok) throw new Error("expected a merge");
		expect(
			(dropped.content as Deck).slides.map((slide) => slide.title),
		).toEqual(["One", "Three"]);
	});

	it("takes the chosen paragraph text", () => {
		const base = doc(["a", "b"]);
		const result = mergeOutputContent(
			base,
			doc(["a", "b mine"]),
			doc(["a theirs", "b theirs"]),
			"mine",
		);
		if (!result.ok) throw new Error("expected a merge");
		expect(
			(result.content as Doc).richText!.content.map(
				(node) => node.content?.[0]?.text,
			),
		).toEqual(["a theirs", "b mine"]);
	});
});
