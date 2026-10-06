import type {
	OsDocumentBlock,
	OsOutputContent,
	OsPresentationCanvasSlide,
	OsPresentationDeck,
	OsPresentationElement,
	OsRichTextDocument,
	OsRichTextNode,
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

export const PRESENTATION_WIDTH = 1200;
export const PRESENTATION_HEIGHT = 675;

/**
 * Keep authored slide measurements in the canonical 1200px coordinate space
 * while rendering them at the width of the current slide canvas. The owning
 * canvas must establish an inline-size query container.
 */
export function safeImageSource(source: unknown): string | undefined {
	if (typeof source !== "string") return undefined;
	return /^(https:\/\/|data:image\/(?:png|jpeg|gif|webp|svg\+xml);)/i.test(
		source,
	)
		? source
		: undefined;
}

export function presentationCanvasLength(value: number): string {
	return `calc(${value} * 100cqw / ${PRESENTATION_WIDTH})`;
}

export function createOutputNodeId(prefix: string): string {
	return `${prefix}-${crypto.randomUUID()}`;
}

function textNode(text: string): OsRichTextNode[] {
	return text ? [{ type: "text", text }] : [];
}

/** Upgrade the stable block projection to the editor's Tiptap document. */
export function richTextFromBlocks(
	blocks: readonly OsDocumentBlock[],
): OsRichTextDocument {
	return {
		type: "doc",
		content: blocks.map((block): OsRichTextNode => {
			switch (block.type) {
				case "heading":
					return {
						type: "heading",
						attrs: { level: block.level },
						content: textNode(block.text),
					};
				case "paragraph":
					return { type: "paragraph", content: textNode(block.text) };
				case "list":
					return {
						type: block.ordered ? "orderedList" : "bulletList",
						content: block.items.map((item) => ({
							type: "listItem",
							content: [{ type: "paragraph", content: textNode(item) }],
						})),
					};
				case "code":
					return {
						type: "codeBlock",
						attrs: { language: block.language ?? null },
						content: textNode(block.text),
					};
				case "quote":
					return {
						type: "blockquote",
						content: [{ type: "paragraph", content: textNode(block.text) }],
					};
			}
		}),
	};
}

function markedText(node: OsRichTextNode): string {
	let value = node.text ?? (node.content ?? []).map(markedText).join("");
	for (const mark of node.marks ?? []) {
		switch (mark.type) {
			case "bold":
				value = `**${value}**`;
				break;
			case "italic":
				value = `_${value}_`;
				break;
			case "strike":
				value = `~~${value}~~`;
				break;
			case "code":
				value = `\`${value}\``;
				break;
			case "link": {
				const href = mark.attrs?.href;
				if (typeof href === "string") value = `[${value}](${href})`;
				break;
			}
		}
	}
	return value;
}

function nodeText(node: OsRichTextNode): string {
	return node.text ?? (node.content ?? []).map(markedText).join("");
}

/** Project rich editor JSON back to the stable headless block vocabulary. */
export function blocksFromRichText(
	document: OsRichTextDocument,
): OsDocumentBlock[] {
	const blocks: OsDocumentBlock[] = [];
	for (const node of document.content) {
		switch (node.type) {
			case "heading":
				blocks.push({
					type: "heading",
					level: Math.min(4, Math.max(1, Number(node.attrs?.level) || 2)),
					text: nodeText(node).slice(0, 2_000),
				});
				break;
			case "bulletList":
			case "orderedList":
				blocks.push({
					type: "list",
					ordered: node.type === "orderedList",
					items: (node.content ?? []).map(nodeText).slice(0, 200),
				});
				break;
			case "codeBlock":
				blocks.push({
					type: "code",
					...(typeof node.attrs?.language === "string"
						? { language: node.attrs.language }
						: {}),
					text: nodeText(node).slice(0, 40_000),
				});
				break;
			case "blockquote":
				blocks.push({
					type: "quote",
					text: nodeText(node).slice(0, 20_000),
				});
				break;
			case "image": {
				const src = node.attrs?.src;
				const alt =
					typeof node.attrs?.alt === "string"
						? node.attrs.alt.slice(0, 2_000)
						: "Image";
				// This is a semantic projection, not a second binary image store.
				// Embedding data URLs here violates paragraph limits and duplicates media.
				const url =
					typeof src === "string" &&
					/^https?:\/\//i.test(src) &&
					src.length <= 2_048
						? src
						: null;
				blocks.push({
					type: "paragraph",
					text: url ? `![${alt}](${url})` : `[Image: ${alt}]`,
				});
				break;
			}
			case "horizontalRule":
				blocks.push({ type: "paragraph", text: "---" });
				break;
			default: {
				const text = nodeText(node);
				if (text || node.type === "paragraph") {
					blocks.push({ type: "paragraph", text: text.slice(0, 20_000) });
				}
			}
		}
	}
	return blocks.slice(0, 500);
}

export function normalizeDocumentContent(
	content: DocumentContent,
): DocumentContent {
	return content.richText
		? content
		: { ...content, richText: richTextFromBlocks(content.blocks) };
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
