import { Editor, Node, mergeAttributes } from "@tiptap/core";
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

export function createDocEngine(options: {
	element: HTMLElement;
	editable: boolean;
	onUpdate: () => void;
}) {
	return new Editor({
		...options,
		content: { type: "doc", content: [{ type: "paragraph" }] },
		editorProps: {
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
