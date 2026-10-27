import {
	ROW_REVIEW_RESULT_SCHEMA,
	ROW_REVIEW_SCHEMA,
	RowReviewSpecSchema,
	type RowReviewRowVerdict,
	type RowReviewSpec,
} from "../schemas/os-row-review";
import type { SheetBody } from "./card-review";
import type { JsonValue } from "../schemas/common";

/**
 * The row-review spec an interaction carries in `metadata.rowReview`, or null
 * when the request is not a valid row-review card. Only requests whose
 * metadata names the row-review schema are considered; a malformed spec
 * degrades the card to a plain question rather than a half-written sheet.
 */
export function rowReviewSpec(
	metadata: Record<string, unknown> | null | undefined,
): RowReviewSpec | null {
	if (metadata?.schema !== ROW_REVIEW_SCHEMA) return null;
	return RowReviewSpecSchema.safeParse(metadata.rowReview).data ?? null;
}

export type SheetRangeWrite = {
	startRow: number;
	startColumn: number;
	cells: (string | number | boolean | null)[][];
};

type Cell = string | number | boolean | null;

/**
 * Build one bounded rectangle so the complete answer lands in one sheet
 * revision. Cells between reviewed rows and named columns retain their current
 * values.
 */
export function rowReviewWrites(
	body: SheetBody,
	spec: RowReviewSpec,
	verdicts: readonly RowReviewRowVerdict[],
): SheetRangeWrite[] {
	const exactColumn = (name: string, purpose: string) => {
		const wanted = name.trim().toLowerCase();
		const matches = body.columns.flatMap((column, index) =>
			column.trim().toLowerCase() === wanted ? [index] : [],
		);
		if (matches.length === 0)
			throw new Error(`The sheet has no "${name}" column for ${purpose}`);
		if (matches.length > 1)
			throw new Error(`The sheet has more than one "${name}" column`);
		return matches[0]!;
	};
	const status = exactColumn(spec.columns.status, "the verdict");
	const correction = exactColumn(spec.columns.correction, "corrections");
	const proposed = new Set(spec.rows.map((row) => row.row));
	const seen = new Set<number>();
	const ordered = [...verdicts].sort((a, b) => a.row - b.row);
	for (const verdict of ordered) {
		if (!proposed.has(verdict.row))
			throw new Error(`Sheet row ${verdict.row} was not proposed for review`);
		if (seen.has(verdict.row))
			throw new Error(`Sheet row ${verdict.row} was answered twice`);
		seen.add(verdict.row);
		if (verdict.row >= body.rows.length)
			throw new Error(`Sheet row ${verdict.row} is out of range`);
	}
	for (const row of spec.rows) {
		if (!seen.has(row.row))
			throw new Error(`Sheet row ${row.row} still needs an answer`);
		if (row.row >= body.rows.length)
			throw new Error(`Sheet row ${row.row} is out of range`);
	}
	const startRow = ordered[0]!.row;
	const endRow = ordered[ordered.length - 1]!.row;
	if (endRow - startRow >= 200)
		throw new Error("Reviewed rows must fit within one 200-row sheet range");
	const startColumn = Math.min(status, correction);
	const endColumn = Math.max(status, correction);
	if (endColumn - startColumn >= 64)
		throw new Error("Review columns must fit within one 64-column sheet range");
	const byRow = new Map(ordered.map((verdict) => [verdict.row, verdict]));
	const cells: Cell[][] = [];
	for (let row = startRow; row <= endRow; row += 1) {
		const current = body.rows[row] ?? [];
		const verdict = byRow.get(row);
		const line: Cell[] = [];
		for (let index = startColumn; index <= endColumn; index += 1) {
			if (verdict && index === status) line.push(verdict.verdict);
			else if (verdict && index === correction)
				line.push(verdict.correction ?? "");
			else line.push(current[index] ?? null);
		}
		cells.push(line);
	}
	return [{ startRow, startColumn, cells }];
}

/** The proposed rows as the card's readable body, one line each. */
export function rowReviewDisplayRows(spec: RowReviewSpec): string {
	return spec.rows
		.map((row, index) => `${index + 1}. ${row.label} — ${row.proposal}`)
		.join("\n");
}

/** The answer's plain-English summary, e.g. "8 rows confirmed, 2 corrected". */
export function rowReviewSummary(
	verdicts: readonly RowReviewRowVerdict[],
): string {
	const confirmed = verdicts.filter(
		(verdict) => verdict.verdict === "confirmed",
	).length;
	const corrected = verdicts.length - confirmed;
	const parts = [
		confirmed ? `${confirmed} row${confirmed === 1 ? "" : "s"} confirmed` : "",
		corrected ? `${corrected} row${corrected === 1 ? "" : "s"} corrected` : "",
	].filter(Boolean);
	return parts.join(", ") || "No rows reviewed";
}

/** Response metadata linking the answer to the sheet revision it wrote. */
export function rowReviewResultMetadata(input: {
	sheetOutputId: string;
	revision: number;
	revisionId: string;
	verdicts: readonly RowReviewRowVerdict[];
	source: string;
}): Record<string, JsonValue> {
	return {
		schema: ROW_REVIEW_RESULT_SCHEMA,
		decisionClass: "row_review",
		cardAction: "row_review",
		source: input.source,
		sheet: {
			outputId: input.sheetOutputId,
			revision: input.revision,
			revisionId: input.revisionId,
		},
		verdicts: input.verdicts.map((verdict) => ({
			row: verdict.row,
			verdict: verdict.verdict,
		})),
	};
}
