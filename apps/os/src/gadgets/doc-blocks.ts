import type { Editor } from "@tiptap/core";
import type { Node as DocNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/**
 * Block handles and block selection for the Doc editor: a "+" and a grip in
 * the margin beside the block under the pointer, dragging a block (or the
 * selected blocks) to a new place, the block menu, and selecting whole blocks
 * with Esc, Shift+arrows or a sweep in the margin.
 */

/** A block the handles act on: a top-level block, or a list item. */
export interface Unit {
	pos: number;
	node: DocNode;
	depth: number;
}

export interface DocumentHeading {
	pos: number;
	level: 1 | 2 | 3;
	label: string;
}

/** Non-empty H1-H3 entries in document order, for the margin outline. */
export function documentHeadings(editor: Editor): DocumentHeading[] {
	const headings: DocumentHeading[] = [];
	editor.state.doc.descendants((node, pos) => {
		if (node.type.name !== "heading") return;
		const level = Number(node.attrs.level);
		const label = node.textContent.trim();
		if (label && (level === 1 || level === 2 || level === 3))
			headings.push({ pos, level, label });
	});
	return headings;
}

const LIST_ITEMS = new Set(["listItem", "taskItem"]);

/** The unit holding document position `pos`: the innermost list item, else the top-level block. */
export function unitAt(editor: Editor, pos: number): Unit | undefined {
	const doc = editor.state.doc;
	if (!doc.childCount) return undefined;
	const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
	for (let depth = $pos.depth; depth > 1; depth--)
		if (LIST_ITEMS.has($pos.node(depth).type.name))
			return { pos: $pos.before(depth), node: $pos.node(depth), depth };
	const index = Math.min($pos.index(0), doc.childCount - 1);
	let start = 0;
	for (let i = 0; i < index; i++) start += doc.child(i).nodeSize;
	return { pos: start, node: doc.child(index), depth: 1 };
}

/** The unit's siblings: where they start, so a drop can land before any of them. */
function siblings(editor: Editor, unit: Unit) {
	const $pos = editor.state.doc.resolve(unit.pos);
	const parent = $pos.parent,
		parentStart = $pos.start();
	const starts: number[] = [];
	let at = parentStart;
	parent.forEach((child) => {
		starts.push(at);
		at += child.nodeSize;
	});
	return { parent, starts, end: at, index: $pos.index() };
}

/** Move `unit` so it lands before its sibling `to` (or at the end). */
export function moveUnit(editor: Editor, unit: Unit, to: number): boolean {
	const { starts, end, index } = siblings(editor, unit);
	if (to === index || to === index + 1) return false;
	const target = to >= starts.length ? end : starts[to]!;
	const tr = editor.state.tr.delete(unit.pos, unit.pos + unit.node.nodeSize);
	const at = tr.mapping.map(target, to > index ? 1 : -1);
	tr.insert(at, unit.node);
	tr.setSelection(TextSelection.near(tr.doc.resolve(at + 1)));
	editor.view.dispatch(tr.scrollIntoView());
	return true;
}

/** Put a copy of `unit` right after it. */
export function duplicateUnit(editor: Editor, unit: Unit) {
	const end = unit.pos + unit.node.nodeSize;
	const tr = editor.state.tr.insert(end, unit.node.copy(unit.node.content));
	tr.setSelection(TextSelection.near(tr.doc.resolve(end + 1)));
	editor.view.dispatch(tr.scrollIntoView());
}

/** Remove `unit`; the last list item takes its list with it, and a document keeps one block. */
export function deleteUnit(editor: Editor, unit: Unit) {
	const { doc, schema } = editor.state;
	const $pos = doc.resolve(unit.pos);
	let from = unit.pos,
		to = unit.pos + unit.node.nodeSize;
	if (unit.depth > 1 && $pos.parent.childCount === 1) {
		from = $pos.before();
		to = $pos.after();
	}
	const tr =
		doc.childCount === 1 && from === 0 && to === doc.content.size
			? editor.state.tr.replaceWith(
					0,
					doc.content.size,
					schema.nodes.paragraph!.create(),
				)
			: editor.state.tr.delete(from, to);
	tr.setSelection(
		TextSelection.near(tr.doc.resolve(Math.min(from, tr.doc.content.size))),
	);
	editor.view.dispatch(tr);
}

// ---- Block selection: whole top-level blocks, shown tinted ----

const selectionKey = new PluginKey<{ from: number; to: number } | null>(
	"blockSelection",
);

/** The editor plugin that tints selected blocks. */
export function blockSelectionPlugin() {
	return new Plugin<{ from: number; to: number } | null>({
		key: selectionKey,
		state: {
			init: () => null,
			apply(tr, value) {
				const meta = tr.getMeta(selectionKey);
				if (meta !== undefined) return meta;
				return tr.docChanged ? null : value;
			},
		},
		props: {
			decorations(state) {
				const range = selectionKey.getState(state);
				if (!range) return DecorationSet.empty;
				const decorations: Decoration[] = [];
				let at = 0;
				state.doc.forEach((child, _, index) => {
					if (index >= range.from && index <= range.to)
						decorations.push(
							Decoration.node(at, at + child.nodeSize, {
								class: "doc-block-selected",
							}),
						);
					at += child.nodeSize;
				});
				return DecorationSet.create(state.doc, decorations);
			},
		},
	});
}

/** The selected top-level blocks as indexes, or null. */
export function blockSelection(
	editor: Editor,
): { from: number; to: number } | null {
	return selectionKey.getState(editor.state) ?? null;
}

/** Select top-level blocks `anchor`..`head` (in either order), or clear with null. */
export function setBlockSelection(
	editor: Editor,
	range: { anchor: number; head: number } | null,
) {
	const count = editor.state.doc.childCount;
	const value = range
		? {
				from: Math.max(0, Math.min(range.anchor, range.head)),
				to: Math.min(count - 1, Math.max(range.anchor, range.head)),
			}
		: null;
	editor.view.dispatch(editor.state.tr.setMeta(selectionKey, value));
	anchorHead = range ? { ...range } : null;
}
let anchorHead: { anchor: number; head: number } | null = null;

/** Where top-level block `index` starts. */
function blockStart(editor: Editor, index: number) {
	let start = 0;
	for (let i = 0; i < index; i++) start += editor.state.doc.child(i).nodeSize;
	return start;
}

/** Move the selected blocks up or down by one, keeping them selected. */
function moveSelected(editor: Editor, by: -1 | 1) {
	const range = blockSelection(editor);
	if (!range) return;
	const doc = editor.state.doc;
	if (
		(by < 0 && range.from === 0) ||
		(by > 0 && range.to >= doc.childCount - 1)
	)
		return;
	const from = blockStart(editor, range.from),
		to = blockStart(editor, range.to + 1);
	const slice = doc.slice(from, to);
	const tr = editor.state.tr.delete(from, to);
	const target =
		by < 0
			? blockStart(editor, range.from - 1)
			: tr.mapping.map(
					blockStart(
						editor,
						range.to + 2 > doc.childCount ? doc.childCount : range.to + 2,
					),
				);
	tr.insert(by < 0 ? target : target, slice.content);
	tr.setMeta(selectionKey, { from: range.from + by, to: range.to + by });
	editor.view.dispatch(tr.scrollIntoView());
	if (anchorHead)
		anchorHead = { anchor: anchorHead.anchor + by, head: anchorHead.head + by };
}

/** Delete the selected blocks; a document keeps one empty block. */
function deleteSelected(editor: Editor) {
	const range = blockSelection(editor);
	if (!range) return;
	const doc = editor.state.doc;
	const from = blockStart(editor, range.from),
		to = blockStart(editor, range.to + 1);
	const tr =
		from === 0 && to === doc.content.size
			? editor.state.tr.replaceWith(
					0,
					doc.content.size,
					editor.state.schema.nodes.paragraph!.create(),
				)
			: editor.state.tr.delete(from, to);
	tr.setMeta(selectionKey, null);
	tr.setSelection(
		TextSelection.near(tr.doc.resolve(Math.min(from, tr.doc.content.size))),
	);
	editor.view.dispatch(tr);
	anchorHead = null;
}

/** Put copies of the selected blocks after them and select the copies. */
function duplicateSelected(editor: Editor) {
	const range = blockSelection(editor);
	if (!range) return;
	const from = blockStart(editor, range.from),
		to = blockStart(editor, range.to + 1);
	const tr = editor.state.tr.insert(
		to,
		editor.state.doc.slice(from, to).content,
	);
	const size = range.to - range.from + 1;
	tr.setMeta(selectionKey, { from: range.from + size, to: range.to + size });
	editor.view.dispatch(tr.scrollIntoView());
	anchorHead = { anchor: range.from + size, head: range.to + size };
}

/**
 * Keys while blocks are selected: arrows move or extend the selection,
 * Alt or Cmd with Shift and an arrow moves the blocks, Backspace deletes,
 * Cmd+D duplicates, Cmd+A selects every block, Enter goes back to the text,
 * Esc clears. Returns whether the key was handled.
 */
export function blockSelectionKey(
	editor: Editor,
	event: KeyboardEvent,
): boolean {
	const range = blockSelection(editor);
	const mod = event.metaKey || event.ctrlKey;
	if (!range) {
		if (event.key !== "Escape" || mod || event.shiftKey || event.altKey)
			return false;
		const { $from, $to } = editor.state.selection;
		setBlockSelection(editor, { anchor: $from.index(0), head: $to.index(0) });
		return true;
	}
	const count = editor.state.doc.childCount;
	const current = anchorHead ?? { anchor: range.from, head: range.to };
	const key = event.key;
	if (
		(key === "ArrowUp" || key === "ArrowDown") &&
		event.shiftKey &&
		(event.altKey || mod)
	) {
		moveSelected(editor, key === "ArrowUp" ? -1 : 1);
		return true;
	}
	if (key === "ArrowUp" || key === "ArrowDown") {
		const by = key === "ArrowUp" ? -1 : 1;
		const head = Math.max(0, Math.min(count - 1, current.head + by));
		setBlockSelection(
			editor,
			event.shiftKey
				? { anchor: current.anchor, head }
				: { anchor: head, head },
		);
		return true;
	}
	if (key === "Backspace" || key === "Delete") {
		deleteSelected(editor);
		return true;
	}
	if (mod && key.toLowerCase() === "d") {
		duplicateSelected(editor);
		return true;
	}
	if (mod && key.toLowerCase() === "a") {
		setBlockSelection(editor, { anchor: 0, head: count - 1 });
		return true;
	}
	if (key === "Enter" || key === "Escape") {
		const end =
			blockStart(editor, range.to) + editor.state.doc.child(range.to).nodeSize;
		setBlockSelection(editor, null);
		if (key === "Enter")
			editor
				.chain()
				.focus()
				.setTextSelection(
					TextSelection.near(editor.state.doc.resolve(end - 1), -1).from,
				)
				.run();
		return true;
	}
	if (key === "Shift" || key === "Meta" || key === "Control" || key === "Alt")
		return true;
	// Anything else goes back to editing text.
	setBlockSelection(editor, null);
	return false;
}

/** Drop the block selection when the person clicks into the text. */
export function clearBlockSelection(editor: Editor) {
	if (blockSelection(editor)) setBlockSelection(editor, null);
}

/** Block-level helpers exposed for the menu and the tests. */
export const blocks = {
	moveSelected,
	deleteSelected,
	duplicateSelected,
	blockStart,
};
