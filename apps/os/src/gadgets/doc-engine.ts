import { OS_EDITOR_UNDO_STEPS } from "@tedix/api-contract/utils/os-output-limits";
import { Editor, Extension, Node, mergeAttributes } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Node as DocNode } from "@tiptap/pm/model";
import { diffOutputContent } from "@tedix/api-contract/utils/output-patch";
import { landedDelay } from "../lib/landed-changes";
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

/** A part of the document someone else just changed: words, or a whole block. */
export interface LandedRange {
	from: number;
	to: number;
	words: boolean;
}

/**
 * Where `after` differs from `before`, as the smallest parts that say it:
 * the changed words of a paragraph that was edited in place, or the block,
 * list item or table cell that is new. Removed parts leave nothing to show.
 */
export function landedRanges(before: DocNode, after: DocNode): LandedRange[] {
	const ranges: LandedRange[] = [];
	const whole = (node: DocNode, pos: number) =>
		ranges.push({ from: pos, to: pos + node.nodeSize, words: false });
	const mark = (old: DocNode | undefined, node: DocNode, pos: number) => {
		if (old?.type !== node.type || node.isLeaf) return whole(node, pos);
		if (node.isTextblock) {
			const start = old.content.findDiffStart(node.content);
			if (start === null) return;
			let end = old.content.findDiffEnd(node.content)!.b;
			if (end < start) end = start;
			return end > start
				? ranges.push({ from: pos + 1 + start, to: pos + 1 + end, words: true })
				: whole(node, pos);
		}
		if (old.childCount !== node.childCount) return whole(node, pos);
		node.forEach((child, offset, index) => {
			if (!child.eq(old.child(index)))
				mark(old.child(index), child, pos + 1 + offset);
		});
	};
	const content = (doc: DocNode) => ({
		kind: "document" as const,
		blocks: [],
		richText: doc.toJSON(),
	});
	const starts: number[] = [];
	after.forEach((_, offset) => starts.push(offset));
	let shift = 0;
	for (const op of diffOutputContent(content(before), content(after))?.ops ??
		[]) {
		if (op.op !== "splice" || op.path.join() !== "richText,content") continue;
		for (const hunk of op.hunks) {
			hunk.insert.forEach((_, index) => {
				const at = hunk.at + shift + index;
				mark(
					hunk.remove === hunk.insert.length
						? before.child(hunk.at + index)
						: undefined,
					after.child(at),
					starts[at]!,
				);
			});
			shift += hunk.insert.length - hunk.remove;
		}
	}
	return ranges;
}

const landedKey = new PluginKey<DecorationSet>("landed");
/**
 * Lights the parts someone else just changed, one after another, and lets
 * them follow the text while the person keeps typing.
 */
const Landed = Extension.create({
	name: "landed",
	addProseMirrorPlugins() {
		return [
			new Plugin({
				key: landedKey,
				state: {
					init: () => DecorationSet.empty,
					apply(tr, shown) {
						const ranges: LandedRange[] | undefined = tr.getMeta(landedKey);
						if (!ranges) return shown.map(tr.mapping, tr.doc);
						return DecorationSet.create(
							tr.doc,
							ranges.map(({ from, to, words }, index) => {
								const attrs = {
									class: words ? "doc-landed-words" : "doc-landed",
									style: `animation-delay:${landedDelay(index, ranges.length)}ms`,
								};
								return words
									? Decoration.inline(from, to, attrs)
									: Decoration.node(from, to, attrs);
							}),
						);
					},
				},
				props: {
					decorations: (state) => landedKey.getState(state),
				},
			}),
		];
	},
});
/** Light these parts of the document; an empty list puts the lights out. */
export function showLanded(editor: Editor, ranges: LandedRange[]) {
	editor.view.dispatch(
		editor.state.tr
			.setMeta(landedKey, ranges)
			.setMeta("addToHistory", false)
			.setMeta("preventUpdate", true),
	);
}

/**
 * Embedded copies of the images the frame may not load itself, by source: a
 * web link or an image stored with the file (`tedix-asset:` reference). ""
 * while loading or after a failure.
 */
const embedded = new Map<string, string>();
let linkedRoot: HTMLElement | undefined,
	readLinked: ((url: string) => Promise<string>) | undefined;

function requestLinked(link: string) {
	embedded.set(link, "");
	void readLinked?.(link).then(
		(source) => {
			embedded.set(link, source);
			for (const image of linkedRoot?.querySelectorAll("img") ?? [])
				if (image.dataset.linkedImage === link) image.src = source;
		},
		() => undefined,
	);
}
/** Ask again for linked images that could not be read. */
export function retryLinkedImages() {
	for (const [link, source] of embedded) if (!source) requestLinked(link);
}

export function createDocEngine(options: {
	element: HTMLElement;
	editable: boolean;
	onUpdate: () => void;
	readImage?: (url: string) => Promise<string>;
}) {
	const { readImage, ...editorOptions } = options;
	linkedRoot = options.element;
	readLinked = readImage;
	return new Editor({
		...editorOptions,
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
			StarterKit.configure({
				link: { openOnClick: false, autolink: true },
				undoRedo: { depth: OS_EDITOR_UNDO_STEPS },
			}),
			TableKit.configure({ table: { resizable: true } }),
			TaskList,
			TaskItem.configure({ nested: true }),
			Details.configure({ persist: true }),
			DetailsSummary,
			DetailsContent,
			DocumentFormatting,
			Placeholder,
			Landed,
			TextStyle,
			FontFamily,
			FontSize,
			Color,
			Highlight.configure({ multicolor: true }),
			Image.extend({
				addAttributes() {
					return {
						...this.parent?.(),
						// The document keeps the link or reference; only what is drawn changes.
						src: {
							default: null,
							parseHTML: (element: HTMLElement) =>
								element.getAttribute("data-linked-image") ??
								element.getAttribute("src"),
							// The frame may not load web or stored images: draw the
							// embedded copy, or one transparent pixel until it arrives.
							renderHTML: ({ src }: { src?: unknown }) => {
								if (
									typeof src !== "string" ||
									!/^(https|tedix-asset):/i.test(src)
								)
									return { src };
								if (!embedded.has(src)) requestLinked(src);
								return {
									src:
										embedded.get(src) ||
										"data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==",
									"data-linked-image": src,
								};
							},
						},
					};
				},
			}).configure({
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
