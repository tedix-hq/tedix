import { describe, expect, it } from "vite-plus/test";
import {
	ROW_REVIEW_SCHEMA,
	RowReviewSpecSchema,
} from "../schemas/os-row-review";
import {
	rowReviewDisplayRows,
	rowReviewResultMetadata,
	rowReviewSpec,
	rowReviewSummary,
	rowReviewWrites,
} from "./row-review";
import type { SheetBody } from "./card-review";

const spec = RowReviewSpecSchema.parse({
	sheet: {
		outputId: "11111111-1111-4111-8111-111111111111",
		title: "Bewirtungsbelege",
		revision: 3,
	},
	columns: { status: "Status", correction: "Korrektur" },
	rows: [
		{ row: 0, label: "Rewe 12.03", proposal: "Kategorie: Verpflegung" },
		{ row: 2, label: "Vapiano 14.03", proposal: "Teilnehmer: Aaron" },
	],
});

const body: SheetBody = {
	columns: ["Beleg", "Kategorie", "Status", "Anlass", "Korrektur"],
	rows: [
		["Rewe", "Verpflegung", "", "", ""],
		["Baker", "Snack", "", "", ""],
		["Vapiano", "Meal", "", "", ""],
	],
};

describe("rowReviewSpec", () => {
	it("reads the spec only when the schema marker is set", () => {
		expect(
			rowReviewSpec({ schema: ROW_REVIEW_SCHEMA, rowReview: spec }),
		).toEqual(spec);
		expect(rowReviewSpec({ rowReview: spec })).toBeNull();
		expect(
			rowReviewSpec({ schema: ROW_REVIEW_SCHEMA, rowReview: { rows: [] } }),
		).toBeNull();
		expect(rowReviewSpec(null)).toBeNull();
	});
});

describe("rowReviewWrites", () => {
	it("writes verdicts across non-adjacent rows in one rectangle, preserving untouched cells", () => {
		const writes = rowReviewWrites(body, spec, [
			{ row: 0, verdict: "confirmed" },
			{ row: 2, verdict: "corrected", correction: "Aaron, Christian" },
		]);
		expect(writes).toEqual([
			{
				startRow: 0,
				startColumn: 2,
				cells: [
					["confirmed", "", ""],
					["", "", ""],
					["corrected", "", "Aaron, Christian"],
				],
			},
		]);
	});
	it("requires an answer for every proposed row and rejects unknown rows", () => {
		expect(() =>
			rowReviewWrites(body, spec, [{ row: 0, verdict: "confirmed" }]),
		).toThrow("still needs an answer");
		expect(() =>
			rowReviewWrites(body, spec, [
				{ row: 0, verdict: "confirmed" },
				{ row: 2, verdict: "confirmed" },
				{ row: 5, verdict: "confirmed" },
			]),
		).toThrow("was not proposed");
	});
	it("fails plainly when a configured column is missing", () => {
		expect(() =>
			rowReviewWrites(
				{ ...body, columns: ["Beleg", "Kategorie"] },
				spec,
				spec.rows.map((row) => ({ row: row.row, verdict: "confirmed" })),
			),
		).toThrow('no "Status" column');
	});
	it("requires exact, unique named columns", () => {
		const verdicts = spec.rows.map((row) => ({
			row: row.row,
			verdict: "confirmed" as const,
		}));
		expect(() =>
			rowReviewWrites(
				{ ...body, columns: ["Beleg", "Status notes", "Korrektur"] },
				spec,
				verdicts,
			),
		).toThrow('no "Status" column');
		expect(() =>
			rowReviewWrites(
				{ ...body, columns: ["Status", "status", "Korrektur"] },
				spec,
				verdicts,
			),
		).toThrow('more than one "Status" column');
	});
	it("keeps every answer in one bounded sheet revision", () => {
		const farRows = {
			...spec,
			rows: [
				{ row: 0, label: "First", proposal: "A" },
				{ row: 200, label: "Last", proposal: "B" },
			],
		};
		expect(() =>
			rowReviewWrites(
				{ ...body, rows: Array.from({ length: 201 }, () => []) },
				farRows,
				[
					{ row: 0, verdict: "confirmed" },
					{ row: 200, verdict: "confirmed" },
				],
			),
		).toThrow("one 200-row sheet range");
	});
});

describe("rowReviewSummary and result metadata", () => {
	it("summarizes the answer in plain words", () => {
		expect(
			rowReviewSummary([
				{ row: 0, verdict: "confirmed" },
				{ row: 2, verdict: "corrected", correction: "x" },
			]),
		).toBe("1 row confirmed, 1 row corrected");
	});
	it("links the sheet revision the answer wrote", () => {
		const metadata = rowReviewResultMetadata({
			sheetOutputId: spec.sheet.outputId,
			revision: 4,
			revisionId: "rev-4",
			verdicts: [{ row: 0, verdict: "confirmed" }],
			source: "decision_deck",
		});
		expect(metadata).toMatchObject({
			schema: "tedix.row-review-result.v1",
			sheet: {
				outputId: spec.sheet.outputId,
				revision: 4,
				revisionId: "rev-4",
			},
			verdicts: [{ row: 0, verdict: "confirmed" }],
		});
	});
	it("keeps correction text in the sheet instead of response metadata", () => {
		const metadata = rowReviewResultMetadata({
			sheetOutputId: spec.sheet.outputId,
			revision: 4,
			revisionId: "rev-4",
			verdicts: [{ row: 2, verdict: "corrected", correction: "private value" }],
			source: "decision_deck",
		});
		expect(metadata.verdicts).toEqual([{ row: 2, verdict: "corrected" }]);
	});
	it("lists the proposed rows as readable card text", () => {
		expect(rowReviewDisplayRows(spec)).toContain("1. Rewe 12.03");
	});
});
