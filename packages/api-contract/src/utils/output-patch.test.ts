import { describe, expect, it } from "vite-plus/test";
import type { OsOutputContent } from "../schemas/os-workspaces";
import { OsOutputContentSchema } from "../schemas/os-workspaces";
import { blocksFromRichText } from "./os-document";
import { mergeOutputContent } from "./output-merge";
import {
	applyOutputPatch,
	diffOutputContent,
	OutputPatchError,
	outputPatchParts,
	type OutputPatch,
} from "./output-patch";
import { projectPresentationDeck } from "./presentation-patch";

type Doc = Extract<OsOutputContent, { kind: "document" }>;
type Sheet = Extract<OsOutputContent, { kind: "sheet" }>;
type Deck = Extract<OsOutputContent, { kind: "presentation" }>;

const options = {
	documentBlocks: blocksFromRichText,
	presentationSlides: projectPresentationDeck,
};
const paragraph = (text: string) => ({
	type: "paragraph",
	content: [{ type: "text", text }],
});
const doc = (...texts: string[]): Doc => {
	const richText = { type: "doc" as const, content: texts.map(paragraph) };
	return { kind: "document", richText, blocks: blocksFromRichText(richText) };
};
const cell = (input: string | number) => ({
	input: String(input),
	value: input,
});
const sheet = (rows: (string | number | null)[][]): Sheet =>
	OsOutputContentSchema.parse({
		kind: "sheet",
		columns: ["A", "B", "C"],
		rows: rows,
		workbook: {
			activeSheetId: "one",
			sheets: [
				{
					id: "one",
					name: "One",
					columns: ["a", "b", "c"].map((id) => ({
						id,
						label: id.toUpperCase(),
					})),
					rows: rows.map((row) =>
						row.map((value) => (value === null ? null : cell(value))),
					),
				},
				{
					id: "two",
					name: "Two",
					columns: [{ id: "a", label: "A" }],
					rows: [[cell("other")]],
				},
			],
		},
	}) as Sheet;
const element = (id: string, text: string, x = 0) => ({
	id,
	type: "text" as const,
	x,
	y: 0,
	width: 100,
	height: 40,
	text,
});
const deck = (
	slides: Array<{ id: string; elements: ReturnType<typeof element>[] }>,
): Deck => {
	const body = {
		width: 1200,
		height: 675,
		activeSlideId: slides[0]!.id,
		slides: slides.map((slide) => ({
			...slide,
			name: slide.id,
			layout: "blank" as const,
			background: "#ffffff",
		})),
	};
	return OsOutputContentSchema.parse({
		kind: "presentation",
		slides: [],
		deck: body,
	}) as Deck;
};

/** A patch travels as JSON; apply the copy a server would receive. */
const sent = (patch: OutputPatch | null) =>
	JSON.parse(JSON.stringify(patch)) as OutputPatch;
const size = (value: unknown) => JSON.stringify(value).length;

describe("changed-only patches", () => {
	it("returns nothing when only the rebuilt copies or nothing differ", () => {
		const base = doc("one", "two");
		expect(diffOutputContent(base, structuredClone(base))).toBeNull();
		expect(diffOutputContent(base, { ...base, blocks: [] })).toBeNull();
		const grid = sheet([[1, 2, 3]]);
		expect(
			diffOutputContent(grid, { ...grid, rows: [], columns: [] }),
		).toBeNull();
	});

	it("sends one changed block of a long document and rebuilds the plain copy", () => {
		const texts = Array.from({ length: 400 }, (_, i) =>
			`Paragraph ${i} `.repeat(20),
		);
		const base = doc(...texts);
		const next = doc(...texts.map((text, i) => (i === 250 ? "Edited" : text)));
		const patch = diffOutputContent(base, next)!;
		expect(patch).toEqual({
			kind: "document",
			ops: [
				{
					op: "splice",
					path: ["richText", "content"],
					hunks: [{ at: 250, remove: 1, insert: [paragraph("Edited")] }],
				},
			],
		});
		expect(size(patch)).toBeLessThan(size(next) / 500);
		const applied = applyOutputPatch(base, sent(patch), options);
		expect(applied).toEqual(next);
		expect(applied.blocks[250]).toEqual({ type: "paragraph", text: "Edited" });
		// Untouched blocks are the same objects, not copies.
		expect(applied.richText!.content[0]).toBe(base.richText!.content[0]);
	});

	it("handles inserted, removed and separately edited blocks in one patch", () => {
		const base = doc("a", "b", "c", "d", "e", "f");
		const next = doc("a", "new", "b", "C", "e", "f", "tail");
		const patch = diffOutputContent(base, next)!;
		expect(patch.ops).toHaveLength(1);
		expect(applyOutputPatch(base, sent(patch), options)).toEqual(next);
	});

	it("addresses a sheet cell by tab id, row and column", () => {
		const rows = Array.from({ length: 2000 }, (_, i) => [i, `row ${i}`, null]);
		const base = sheet(rows);
		const next = structuredClone(base);
		next.workbook!.sheets[0]!.rows[1500]![2] = cell("x");
		next.rows[1500]![2] = "x";
		const patch = diffOutputContent(base, next)!;
		expect(patch.ops).toEqual([
			{
				op: "set",
				path: ["workbook", "sheets", { id: "one" }, "rows", 1500, 2],
				value: cell("x"),
			},
		]);
		expect(size(patch)).toBeLessThan(200);
		expect(applyOutputPatch(base, sent(patch), options)).toEqual(next);
		expect(outputPatchParts(patch)).toEqual([
			"/workbook/sheets/one/rows/1500/2",
		]);
	});

	it("sends one property of a cell, a tab property and an inserted row", () => {
		const base = sheet([
			[1, 2, 3],
			[4, 5, 6],
			[7, 8, 9],
		]);
		const next = structuredClone(base);
		const tab = next.workbook!.sheets[0]!;
		tab.rows[0]![0] = { ...tab.rows[0]![0]!, format: { bold: true } };
		tab.name = "Renamed";
		tab.frozenRows = 1;
		expect(diffOutputContent(base, next)!.ops).toEqual([
			{
				op: "set",
				path: ["workbook", "sheets", { id: "one" }, "name"],
				value: "Renamed",
			},
			{
				op: "set",
				path: ["workbook", "sheets", { id: "one" }, "rows", 0, 0, "format"],
				value: { bold: true },
			},
			{
				op: "set",
				path: ["workbook", "sheets", { id: "one" }, "frozenRows"],
				value: 1,
			},
		]);
		const longer = structuredClone(base);
		longer.workbook!.sheets[0]!.rows.splice(1, 0, [cell("new"), null, null]);
		const patch = diffOutputContent(base, longer)!;
		expect(patch.ops).toEqual([
			{
				op: "splice",
				path: ["workbook", "sheets", { id: "one" }, "rows"],
				hunks: [{ at: 1, remove: 0, insert: [[cell("new"), null, null]] }],
			},
		]);
		const applied = applyOutputPatch(base, sent(patch), options);
		expect(applied.workbook).toEqual(longer.workbook);
		// The flat copy of the active tab follows the workbook.
		expect(applied.rows).toEqual([
			[1, 2, 3],
			["new", null, null],
			[4, 5, 6],
			[7, 8, 9],
		]);
	});

	it("addresses slides and elements by id, whatever their order", () => {
		const base = deck([
			{ id: "s1", elements: [element("a", "A"), element("b", "B")] },
			{ id: "s2", elements: [element("c", "C")] },
			{ id: "s3", elements: [] },
		]);
		const next = structuredClone(base);
		const slides = next.deck!.slides;
		slides[1]!.elements[0]!.x = 300;
		slides[0]!.elements.push(element("n", "New"));
		slides.push({ ...slides[2]!, id: "s4", name: "s4" });
		slides.splice(2, 1);
		slides.reverse();
		const patch = diffOutputContent(base, next)!;
		expect(patch.ops).toEqual([
			{
				op: "set",
				path: ["deck", "slides", { id: "s2" }, "elements", { id: "c" }, "x"],
				value: 300,
			},
			{
				op: "arrange",
				path: ["deck", "slides", { id: "s1" }, "elements"],
				order: ["a", "b", "n"],
				insert: [element("n", "New")],
			},
			{
				op: "arrange",
				path: ["deck", "slides"],
				order: ["s4", "s2", "s1"],
				insert: [slides[0]],
			},
		]);
		const applied = applyOutputPatch(base, sent(patch), options);
		expect(applied.deck).toEqual(next.deck);
		expect(applied.slides).toEqual(projectPresentationDeck(next.deck!));
		expect(OsOutputContentSchema.safeParse(applied).success).toBe(true);
	});

	it("removes a property and creates a body the base did not have", () => {
		const base = deck([{ id: "s1", elements: [element("a", "A")] }]);
		const next = structuredClone(base);
		next.deck!.slides[0]!.notes = "Say this";
		const add = diffOutputContent(base, next)!;
		expect(applyOutputPatch(base, sent(add), options).deck).toEqual(next.deck);
		const remove = diffOutputContent(next, base)!;
		expect(remove.ops).toEqual([
			{ op: "unset", path: ["deck", "slides", { id: "s1" }, "notes"] },
		]);
		expect(applyOutputPatch(next, sent(remove), options).deck).toEqual(
			base.deck,
		);
		// An outline-only presentation gains its canvas in one operation.
		const outline: Deck = {
			kind: "presentation",
			slides: [{ title: "s1", bullets: [] }],
		};
		const gained = diffOutputContent(outline, base)!;
		expect(gained.ops.map((op) => [op.op, op.path])).toEqual([
			["set", ["deck"]],
		]);
		expect(applyOutputPatch(outline, sent(gained), options).deck).toEqual(
			base.deck,
		);
	});

	it("round-trips every kind of change", () => {
		const cases: [OsOutputContent, OsOutputContent][] = [
			[doc(), doc("first")],
			[doc("a", "b"), doc()],
			[doc("a", "a", "a"), doc("a", "a")],
			[sheet([[1, 2, 3]]), sheet([])],
			[sheet([]), sheet([[1, null, 3]])],
			[
				deck([{ id: "s1", elements: [element("a", "A")] }]),
				deck([{ id: "s9", elements: [element("z", "Z", 5)] }]),
			],
		];
		for (const [base, next] of cases) {
			const patch = diffOutputContent(base, next);
			const applied = patch
				? applyOutputPatch(base, sent(patch), options)
				: base;
			expect(diffOutputContent(applied, next)).toBeNull();
			expect(diffOutputContent(next, applied)).toBeNull();
		}
	});

	it("refuses a patch that does not fit the content", () => {
		const base = deck([{ id: "s1", elements: [element("a", "A")] }]);
		const bad: OutputPatch["ops"][] = [
			[
				{
					op: "set",
					path: ["deck", "slides", { id: "gone" }, "name"],
					value: "x",
				},
			],
			[{ op: "set", path: ["kind"], value: "sheet" }],
			[{ op: "set", path: [], value: {} }],
			[{ op: "set", path: ["__proto__", "polluted"], value: true }],
			[{ op: "set", path: ["deck", "constructor", "x"], value: true }],
			[{ op: "unset", path: ["deck", "slides", { id: "s1" }] }],
			[{ op: "arrange", path: ["deck", "slides"], order: ["s1", "s1"] }],
			[{ op: "arrange", path: ["deck", "slides"], order: ["s2"] }],
			[
				{
					op: "arrange",
					path: ["deck", "slides"],
					order: ["s1"],
					insert: [{ id: "s1" }],
				},
			],
			[
				{
					op: "splice",
					path: ["deck", "slides"],
					hunks: [{ at: 1, remove: 1, insert: [] }],
				},
			],
			[
				{
					op: "splice",
					path: ["deck", "slides"],
					hunks: [
						{ at: 1, remove: 0, insert: [] },
						{ at: 0, remove: 0, insert: [] },
					],
				},
			],
		];
		for (const ops of bad)
			expect(() =>
				applyOutputPatch(base, { kind: "presentation", ops }, options),
			).toThrow(OutputPatchError);
		expect(() =>
			applyOutputPatch(base, { kind: "sheet", ops: [] }, options),
		).toThrow(/patch is for a sheet/);
		expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
	});

	it("lets two people's patches from one base both land through the merge", () => {
		const base = deck([
			{ id: "s1", elements: [element("a", "A"), element("b", "B")] },
			{ id: "s2", elements: [element("c", "C")] },
		]);
		const mine = structuredClone(base);
		mine.deck!.slides[0]!.elements[0]!.text = "Mine";
		const theirs = structuredClone(base);
		theirs.deck!.slides[1]!.elements[0]!.text = "Theirs";
		const applied = applyOutputPatch(
			base,
			sent(diffOutputContent(base, mine)),
			options,
		);
		const merged = mergeOutputContent(base, applied, theirs, options);
		expect(merged.ok).toBe(true);
		const texts = (merged as { content: Deck }).content.deck!.slides.map(
			(slide) => slide.elements[0]!.text,
		);
		expect(texts).toEqual(["Mine", "Theirs"]);
		// The same element changed on both sides is a conflict that names it.
		const clash = structuredClone(base);
		clash.deck!.slides[0]!.elements[0]!.text = "Other";
		expect(mergeOutputContent(base, applied, clash, options)).toEqual({
			ok: false,
			conflicts: ["/deck/slides/s1/elements/a/text"],
		});
	});

	it("keeps a one-cell patch of a 50,000-row sheet small and quick", () => {
		const rows = Array.from({ length: 50_000 }, (_, i) => [
			{ input: String(i), value: i },
			null,
			null,
		]);
		const base: Sheet = {
			kind: "sheet",
			columns: ["A", "B", "C"],
			rows: [],
			workbook: {
				activeSheetId: "one",
				sheets: [
					{
						id: "one",
						name: "One",
						columns: ["a", "b", "c"].map((id) => ({
							id,
							label: id,
							width: 120,
						})),
						rows,
						frozenRows: 0,
						frozenColumns: 0,
					},
				],
			},
		};
		const next = structuredClone(base);
		next.workbook!.sheets[0]!.rows[49_999]![1] = { input: "end", value: "end" };
		const started = performance.now();
		const patch = diffOutputContent(base, next)!;
		const applied = applyOutputPatch(base, sent(patch), {});
		expect(performance.now() - started).toBeLessThan(2_000);
		expect(patch.ops).toHaveLength(1);
		expect(size(patch)).toBeLessThan(200);
		expect(applied.workbook!.sheets[0]!.rows[49_999]![1]).toEqual({
			input: "end",
			value: "end",
		});
		expect(applied.rows).toHaveLength(50_000);
	});
});
