import { Editor, Extension, Node, mergeAttributes } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import StarterKit from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import { TaskList, TaskItem } from "@tiptap/extension-list";
import {
	Details,
	DetailsSummary,
	DetailsContent,
} from "@tiptap/extension-details";
import { Color } from "@tiptap/extension-color";
import { Highlight } from "@tiptap/extension-highlight";
import { Image } from "@tiptap/extension-image";
import { TextAlign } from "@tiptap/extension-text-align";
import { FontFamily, FontSize, TextStyle } from "@tiptap/extension-text-style";
import {
	DocumentFormatting,
	moveDocumentBlock,
	canMoveDocumentBlock,
	applyDocumentStyle,
	currentDocumentStyle,
} from "../lib/document-formatting";

export {
	moveDocumentBlock,
	canMoveDocumentBlock,
	applyDocumentStyle,
	currentDocumentStyle,
};
export { blocksFromRichText } from "@tedix/api-contract/utils/os-document";
export type { Editor };

/**
 * Hint text for an empty document, and the block name on the empty heading
 * or list line the caret is in.
 */
const Placeholder = Extension.create({
	name: "placeholder",
	addProseMirrorPlugins() {
		const editor = this.editor;
		return [
			new Plugin({
				props: {
					decorations({ doc, selection }) {
						if (!editor.isEditable) return null;
						const hint = (from: number, to: number, text: string) =>
							DecorationSet.create(doc, [
								Decoration.node(from, to, { "data-hint": text }),
							]);
						const first = doc.firstChild!;
						if (
							doc.childCount === 1 &&
							first.isTextblock &&
							!first.content.size
						)
							return hint(0, first.nodeSize, "Start writing…");
						const { $from, empty } = selection,
							node = $from.parent;
						if (
							!empty ||
							!node.isTextblock ||
							node.content.size ||
							!$from.depth
						)
							return null;
						const outer = $from.node($from.depth - 1).type.name;
						const text =
							node.type.name === "heading"
								? node.attrs.variant === "title"
									? "Title"
									: `Heading ${node.attrs.level}`
								: outer === "listItem"
									? "List"
									: outer === "taskItem"
										? "To-do"
										: "";
						return text ? hint($from.before(), $from.after(), text) : null;
					},
				},
			}),
		];
	},
});

export function createDocEngine(options: {
	element: HTMLElement;
	editable: boolean;
	onUpdate: () => void;
}) {
	return new Editor({
		...options,
		content: { type: "doc", content: [{ type: "paragraph" }] },
		editorProps: {
			scrollMargin: 64,
			attributes: {
				role: "textbox",
				"aria-label": "Document writing area",
				"aria-multiline": "true",
			},
		},
		extensions: [
			StarterKit.configure({ link: { openOnClick: false, autolink: true } }),
			TableKit.configure({ table: { resizable: true } }),
			TaskList,
			TaskItem.configure({ nested: true }),
			Details.configure({ persist: true }),
			DetailsSummary,
			DetailsContent,
			DocumentFormatting,
			Placeholder,
			TextStyle,
			FontFamily,
			FontSize,
			Color,
			Highlight.configure({ multicolor: true }),
			Image.configure({
				allowBase64: true,
				inline: false,
				resize: {
					enabled: true,
					directions: ["bottom-right"],
					minWidth: 80,
					minHeight: 40,
					alwaysPreserveAspectRatio: true,
				},
			}),
			TextAlign.configure({
				types: ["heading", "paragraph"],
				alignments: ["left", "center", "right", "justify"],
			}),
			Node.create({
				name: "callout",
				group: "block",
				content: "block+",
				defining: true,
				parseHTML: () => [{ tag: 'aside[data-type="callout"]' }],
				renderHTML: ({ HTMLAttributes }) => [
					"aside",
					mergeAttributes(HTMLAttributes, { "data-type": "callout" }),
					0,
				],
			}),
		],
	});
}
