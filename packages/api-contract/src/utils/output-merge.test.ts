import { describe, expect, it } from "vite-plus/test";
import type {
	OsOutputContent,
	OsRichTextNode,
	OsWorkbookCell,
} from "../schemas/os-workspaces";
import { mergeOutputContent } from "./output-merge";

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
