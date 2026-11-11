import type { EditorPath } from "@/lib/editor-patches";
import {
	projectDeck,
	projectWorkbook,
	type PresentationContent,
	type SheetContent,
} from "@/lib/output-models";
import type { EditorHistoryOptions } from "@/lib/use-editor-history";
import { evaluateWorkbook } from "@/lib/workbook-formulas";

/**
 * What undo records for each structured output. Projections (`slides`, a
 * sheet's top-level `columns`/`rows`) and recalculated cell values are derived,
 * and which slide or tab is active is view state: recording them would make a
 * colleague's unrelated edit look like a conflict. Undo rebuilds them instead.
 */
export const SHEET_HISTORY: EditorHistoryOptions<SheetContent> = {
	ignore: (path: EditorPath) =>
		path[0] === "columns" ||
		path[0] === "rows" ||
		(path[0] === "workbook" && path[1] === "activeSheetId") ||
		(path[0] === "workbook" && path[3] === "rows" && path[6] === "value"),
	project: (content) =>
		content.workbook
			? projectWorkbook(evaluateWorkbook(content.workbook))
			: content,
};

export const DECK_HISTORY: EditorHistoryOptions<PresentationContent> = {
	ignore: (path: EditorPath) =>
		path[0] === "slides" || (path[0] === "deck" && path[1] === "activeSlideId"),
	project: (content) => (content.deck ? projectDeck(content.deck) : content),
};
