/**
 * Collaborators' carets and selections in the rich document editor.
 *
 * Peers publish ProseMirror positions through room presence
 * (`CollabSelection.space === "rich-text"`). This plugin holds the latest one
 * per collaborator and draws a named caret plus a tinted selection.
 *
 * Positions are mapped through LOCAL edits only. A remote change already moved
 * its author's caret on their side, and they re-publish it; mapping it again
 * here would push it past the text they just typed.
 *
 * Idle fading is CSS: each caret's DOM is keyed by when it last moved, so a
 * move recreates the element and restarts its fade animation.
 */
import type { Node as PmNode } from "@tiptap/pm/model";
import {
	type EditorState,
	Plugin,
	PluginKey,
	TextSelection,
	type Transaction,
} from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export interface RemoteCursor {
	/** Stable per collaborator. */
	key: string;
	name: string;
	color: string;
	anchor: number;
	head: number;
}

type TrackedCursor = RemoteCursor & { movedAt: number };

type CursorState = {
	cursors: TrackedCursor[];
	decorations: DecorationSet;
};

export const remoteCursorsKey = new PluginKey<CursorState>(
	"tedixRemoteCursors",
);

/** Meta set on transactions that apply a remote document change. */
export const REMOTE_CHANGE_META = "tedixRemoteChange";

/** Replace the set of collaborator cursors. */
export function setRemoteCursors(
	tr: Transaction,
	cursors: readonly RemoteCursor[],
	now = Date.now(),
): Transaction {
	return tr
		.setMeta(remoteCursorsKey, { cursors, now })
		.setMeta("addToHistory", false);
}

function clampedRange(doc: PmNode, cursor: RemoteCursor) {
	const size = doc.content.size;
	// Snap to the nearest valid text positions, so a stale or out-of-range
	// position still renders inside a paragraph rather than between blocks.
	const selection = TextSelection.between(
		doc.resolve(Math.max(0, Math.min(cursor.anchor, size))),
		doc.resolve(Math.max(0, Math.min(cursor.head, size))),
	);
	return { anchor: selection.anchor, head: selection.head };
}

function caretElement(cursor: TrackedCursor): HTMLElement {
	const caret = document.createElement("span");
	caret.className = "collab-caret";
	caret.style.setProperty("--collab-color", cursor.color);
	caret.setAttribute("aria-hidden", "true");
	caret.dataset.collabCaret = cursor.key;
	const label = document.createElement("span");
	label.className = "collab-caret-label";
	label.textContent = cursor.name;
	caret.append(label);
	return caret;
}

export function remoteCursorDecorations(
	doc: PmNode,
	cursors: readonly TrackedCursor[],
): DecorationSet {
	const decorations: Decoration[] = [];
	for (const cursor of cursors) {
		const { anchor, head } = clampedRange(doc, cursor);
		const from = Math.min(anchor, head);
		const to = Math.max(anchor, head);
		if (from < to) {
			decorations.push(
				Decoration.inline(
					from,
					to,
					{
						class: "collab-selection",
						style: `--collab-color: ${cursor.color}`,
						"data-moved": String(cursor.movedAt),
					},
					{ key: `${cursor.key}:selection` },
				),
			);
		}
		decorations.push(
			Decoration.widget(head, () => caretElement(cursor), {
				key: `${cursor.key}:${head}:${cursor.movedAt}`,
				side: -1,
				ignoreSelection: true,
			}),
		);
	}
	return DecorationSet.create(doc, decorations);
}

function track(
	previous: readonly TrackedCursor[],
	next: readonly RemoteCursor[],
	now: number,
): TrackedCursor[] {
	return next.map((cursor) => {
		const before = previous.find((entry) => entry.key === cursor.key);
		const moved =
			!before ||
			before.anchor !== cursor.anchor ||
			before.head !== cursor.head ||
			before.name !== cursor.name;
		return { ...cursor, movedAt: moved ? now : before.movedAt };
	});
}

export function remoteCursorsPlugin(): Plugin<CursorState> {
	return new Plugin<CursorState>({
		key: remoteCursorsKey,
		state: {
			init: (_config, state: EditorState) => ({
				cursors: [],
				decorations: DecorationSet.create(state.doc, []),
			}),
			apply(tr, value, _old, state) {
				const update = tr.getMeta(remoteCursorsKey) as
					| { cursors: readonly RemoteCursor[]; now: number }
					| undefined;
				let cursors = value.cursors;
				if (update) {
					cursors = track(cursors, update.cursors, update.now);
				} else if (tr.docChanged && !tr.getMeta(REMOTE_CHANGE_META)) {
					cursors = cursors.map((cursor) => ({
						...cursor,
						anchor: tr.mapping.map(cursor.anchor),
						head: tr.mapping.map(cursor.head),
					}));
				}
				if (!update && !tr.docChanged) return value;
				return {
					cursors,
					decorations: remoteCursorDecorations(state.doc, cursors),
				};
			},
		},
		props: {
			decorations: (state) => remoteCursorsKey.getState(state)?.decorations,
		},
	});
}
