import { Extension, type Editor } from "@tiptap/core";
import type { OsRichTextNode } from "@tedix/api-contract/schemas/os-workspaces";
import { INDENT_STEP_PX, MAX_INDENT } from "@/lib/output-models";

/**
 * Document formatting that StarterKit does not carry: the Title paragraph
 * style, block indentation outside lists, and the font and size choices.
 *
 * Both attributes default to null so an untouched document serializes exactly
 * as before; the HTML and Word exports read the same attributes.
 */

const INDENTABLE = ["paragraph", "heading", "codeBlock"];

export const DocumentFormatting = Extension.create({
	name: "documentFormatting",
	addGlobalAttributes() {
		return [
			{
				types: ["heading"],
				attributes: {
					variant: {
						default: null,
						parseHTML: (element) =>
							element.classList.contains("doc-title") ? "title" : null,
						renderHTML: (attributes) =>
							attributes.variant === "title" ? { class: "doc-title" } : {},
					},
				},
			},
			{
				types: INDENTABLE,
				attributes: {
					indent: {
						default: null,
						parseHTML: (element) => {
							const px = Number.parseFloat(element.style.marginLeft);
							const level = Math.round(px / INDENT_STEP_PX);
							return level > 0 ? Math.min(level, MAX_INDENT) : null;
						},
						renderHTML: (attributes) =>
							attributes.indent
								? {
										style: `margin-left:${Number(attributes.indent) * INDENT_STEP_PX}px`,
									}
								: {},
					},
				},
			},
		];
	},
});

export type DocumentStyle =
	| "paragraph"
	| "title"
	| "1"
	| "2"
	| "3"
	| "quote"
	| "code";

export const DOCUMENT_STYLES: ReadonlyArray<[DocumentStyle, string]> = [
	["paragraph", "Normal text"],
	["title", "Title"],
	["1", "Heading 1"],
	["2", "Heading 2"],
	["3", "Heading 3"],
	["quote", "Quote"],
	["code", "Code block"],
];

export function currentDocumentStyle(editor: Editor): DocumentStyle {
	if (editor.isActive("codeBlock")) return "code";
	if (editor.isActive("heading", { level: 1, variant: "title" }))
		return "title";
	for (const level of [1, 2, 3] as const) {
		if (editor.isActive("heading", { level }))
			return String(level) as DocumentStyle;
	}
	if (editor.isActive("blockquote")) return "quote";
	return "paragraph";
}

export function applyDocumentStyle(editor: Editor, style: DocumentStyle) {
	const chain = editor.chain().focus();
	if (style !== "quote" && editor.isActive("blockquote"))
		chain.unsetBlockquote();
	switch (style) {
		case "title":
			chain
				.setHeading({ level: 1 })
				.updateAttributes("heading", { variant: "title" });
			break;
		case "1":
		case "2":
		case "3":
			chain
				.setHeading({ level: Number(style) as 1 | 2 | 3 })
				.updateAttributes("heading", { variant: null });
			break;
		case "quote":
			chain.setParagraph();
			if (!editor.isActive("blockquote")) chain.setBlockquote();
			break;
		case "code":
			chain.setCodeBlock();
			break;
		default:
			chain.setParagraph();
	}
	chain.run();
}

/**
 * Indent or outdent the selection. A list item nests or un-nests; any other
 * block moves by one indent level.
 */
export function changeIndent(editor: Editor, direction: 1 | -1): boolean {
	if (editor.isActive("listItem")) {
		return direction > 0
			? editor.chain().focus().sinkListItem("listItem").run()
			: editor.chain().focus().liftListItem("listItem").run();
	}
	return editor
		.chain()
		.focus()
		.command(({ tr, state }) => {
			let changed = false;
			const { from, to } = state.selection;
			state.doc.nodesBetween(from, to, (node, pos) => {
				if (!INDENTABLE.includes(node.type.name)) return true;
				const current = Number(node.attrs.indent) || 0;
				const next = Math.min(MAX_INDENT, Math.max(0, current + direction));
				if (next !== current) {
					tr.setNodeMarkup(pos, undefined, {
						...node.attrs,
						indent: next || null,
					});
					changed = true;
				}
				return false;
			});
			return changed;
		})
		.run();
}

export function canChangeIndent(editor: Editor, direction: 1 | -1): boolean {
	if (editor.isActive("listItem"))
		return direction > 0
			? editor.can().sinkListItem("listItem")
			: editor.can().liftListItem("listItem");
	let possible = false;
	const { from, to } = editor.state.selection;
	editor.state.doc.nodesBetween(from, to, (node) => {
		if (!INDENTABLE.includes(node.type.name)) return true;
		const current = Number(node.attrs.indent) || 0;
		if (direction > 0 ? current < MAX_INDENT : current > 0) possible = true;
		return false;
	});
	return possible;
}

/**
 * The six font choices. "Sans serif" is the document's own face, so it clears
 * the mark. Each stack leads with a family Word and the HTML export can name;
 * Inter is fetched by the Google Fonts loader, the others are system faces.
 */
export const DOCUMENT_FONTS: ReadonlyArray<{ label: string; value: string }> = [
	{ label: "Sans serif", value: "" },
	{ label: "Serif", value: "'Times New Roman', Times, serif" },
	{ label: "Mono", value: "ui-monospace, monospace" },
	{ label: "Inter", value: "Inter, sans-serif" },
	{ label: "Georgia", value: "Georgia, serif" },
	{ label: "Courier", value: "'Courier New', Courier, monospace" },
];

export function documentFontLabel(value: string | undefined): string {
	if (!value) return "Sans serif";
	const match = DOCUMENT_FONTS.find((font) => font.value === value);
	if (match) return match.label;
	return (
		value
			.split(",")[0]!
			.trim()
			.replace(/^["']|["']$/g, "") || "Font"
	);
}

/** Point sizes offered, as in a word processor; the body text is 12 pt. */
export const DOCUMENT_FONT_SIZES_PT = [
	8, 9, 10, 11, 12, 14, 18, 24, 30, 36, 48, 60, 72,
] as const;

/**
 * Sizes are stored in CSS pixels because both exports read `Npx` (1 pt =
 * 4/3 px), so a size picked here prints at the same point size in Word.
 */
export function pointsToFontSize(points: number): string {
	return `${Math.round(((points * 4) / 3) * 100) / 100}px`;
}

export function fontSizeToPoints(size: string | undefined): number | null {
	if (!size) return null;
	const match = /^(\d+(?:\.\d+)?)(px|pt)$/.exec(size.trim());
	if (!match) return null;
	const value = Number(match[1]);
	return match[2] === "pt" ? value : Math.round(value * 0.75 * 2) / 2;
}

/** Every font stack the document's text styles name, for the font loader. */
export function documentFontFamilies(
	nodes: readonly OsRichTextNode[] | undefined,
): string[] {
	const families = new Set<string>();
	const visit = (node: OsRichTextNode) => {
		for (const mark of node.marks ?? []) {
			const family = mark.attrs?.fontFamily;
			if (mark.type === "textStyle" && typeof family === "string")
				families.add(family);
		}
		node.content?.forEach(visit);
	};
	nodes?.forEach(visit);
	return [...families];
}
