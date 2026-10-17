import { normalizeDocumentContent } from "@tedix/api-contract/utils/os-document";
import type {
	OsOutputContent,
	OsPresentationCanvasSlide,
	OsPresentationDeck,
	OsPresentationElement,
	OsSheetCell,
	OsWorkbook,
	OsWorkbookCell,
	OsWorkbookSheet,
} from "@tedix/api-contract/schemas/os-workspaces";

export type DocumentContent = Extract<OsOutputContent, { kind: "document" }>;
export type SheetContent = Extract<OsOutputContent, { kind: "sheet" }>;
export type PresentationContent = Extract<
	OsOutputContent,
	{ kind: "presentation" }
>;

/** Document block indent: pixels per level (as the browser's indent command) and the deepest level. */
export const INDENT_STEP_PX = 40;
export const MAX_INDENT = 8;

export const PRESENTATION_WIDTH = 1200;
export const PRESENTATION_HEIGHT = 675;

export function safeImageSource(source: unknown): string | undefined {
	if (typeof source !== "string") return undefined;
	return /^(https:\/\/|data:image\/(?:png|jpeg|gif|webp|svg\+xml);)/i.test(
		source,
	)
		? source
		: undefined;
}

export function createOutputNodeId(prefix: string): string {
	return `${prefix}-${crypto.randomUUID()}`;
}

function workbookCellFromProjection(
	cell: OsSheetCell | undefined,
): OsWorkbookCell {
	return {
		input: cell === null || cell === undefined ? "" : String(cell),
		value: cell ?? null,
	};
}

export function workbookFromProjection(content: SheetContent): OsWorkbook {
	const sheetId = "sheet-1";
	const columns =
		content.columns.length > 0
			? content.columns.map((label, index) => ({
					id: `column-${index + 1}`,
					label,
					width: 120,
				}))
			: [{ id: "column-1", label: "A", width: 120 }];
	return {
		activeSheetId: sheetId,
		sheets: [
			{
				id: sheetId,
				name: "Sheet1",
				columns,
				rows: content.rows.map((row) =>
					columns.map((_, index) => workbookCellFromProjection(row[index])),
				),
				frozenRows: 0,
				frozenColumns: 0,
			},
		],
	};
}

export function activeWorkbookSheet(workbook: OsWorkbook): OsWorkbookSheet {
	return (
		workbook.sheets.find((sheet) => sheet.id === workbook.activeSheetId) ??
		workbook.sheets[0]!
	);
}

export function projectWorkbook(workbook: OsWorkbook): SheetContent {
	const active = activeWorkbookSheet(workbook);
	return {
		kind: "sheet",
		columns: active.columns.map((column) => column.label),
		rows: active.rows.map((row) =>
			active.columns.map((_, index) => row[index]?.value ?? null),
		),
		workbook,
	};
}

export function normalizeSheetContent(content: SheetContent): SheetContent {
	return content.workbook
		? content
		: projectWorkbook(workbookFromProjection(content));
}

function canvasSlideFromProjection(
	title: string,
	bullets: readonly string[],
	notes: string | undefined,
	index: number,
): OsPresentationCanvasSlide {
	const id = `legacy-slide-${index + 1}`;
	const elements: OsPresentationElement[] = [
		{
			id: `${id}-title`,
			type: "title",
			x: 72,
			y: 64,
			width: 1056,
			height: 96,
			text: title,
			style: { fontSize: 46, fontWeight: "bold", color: "#161616" },
		},
	];
	if (bullets.length > 0) {
		elements.push({
			id: `${id}-bullets`,
			type: "bullet",
			x: 96,
			y: 190,
			width: 1008,
			height: 360,
			text: bullets.join("\n"),
			style: { fontSize: 28, color: "#282828" },
		});
	}
	return {
		id,
		name: title || `Slide ${index + 1}`,
		layout: "title-content",
		background: "#ffffff",
		elements,
		...(notes ? { notes } : {}),
	};
}

export function deckFromProjection(
	content: PresentationContent,
): OsPresentationDeck {
	const slides = content.slides.map((slide, index) =>
		canvasSlideFromProjection(slide.title, slide.bullets, slide.notes, index),
	);
	return {
		width: PRESENTATION_WIDTH,
		height: PRESENTATION_HEIGHT,
		activeSlideId: slides[0]?.id ?? "slide-1",
		slides,
	};
}

export function projectDeck(deck: OsPresentationDeck): PresentationContent {
	return {
		kind: "presentation",
		slides: deck.slides.map((slide) => {
			const ordered = [...slide.elements].sort(
				(a, b) => a.y - b.y || a.x - b.x,
			);
			const title =
				ordered.find((element) => element.type === "title")?.text ?? slide.name;
			const bullets = ordered
				.filter((element) => element.type === "bullet")
				.flatMap((element) => (element.text ?? "").split("\n"))
				.map((item) => item.trim())
				.filter(Boolean)
				.slice(0, 30);
			return {
				title: title.slice(0, 300),
				bullets,
				...(slide.notes ? { notes: slide.notes } : {}),
			};
		}),
		deck,
	};
}

export function normalizePresentationContent(
	content: PresentationContent,
): PresentationContent {
	return content.deck ? content : projectDeck(deckFromProjection(content));
}

export function normalizeOutputContent(
	content: OsOutputContent,
): OsOutputContent {
	switch (content.kind) {
		case "document":
			return normalizeDocumentContent(content);
		case "sheet":
			return normalizeSheetContent(content);
		case "presentation":
			return normalizePresentationContent(content);
		case "video":
			return content;
	}
}
