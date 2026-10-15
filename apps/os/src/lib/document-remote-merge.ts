/**
 * Apply a shared document that moved underneath the rich editor without
 * interrupting the person typing in it.
 *
 * The collab room merges concurrent edits on the document's JSON text (see
 * `@/collab/ot`), so by the time a remote change reaches the editor the merge
 * has already happened: the incoming tree already contains this user's own
 * keystrokes. What remains is to move the editor from the tree it shows to the
 * incoming one with the smallest possible steps, so ProseMirror's own position
 * mapping carries the local selection, stored marks and undo history across.
 *
 * The diff descends through nodes whose structure is unchanged and replaces
 * only the inline range that differs inside each changed block. A peer typing
 * in paragraph 2 therefore produces one step inside paragraph 2, and a caret in
 * paragraph 1 is never covered by a step, so it cannot jump.
 */
import { Fragment, type Node as PmNode, Slice } from "@tiptap/pm/model";
import {
	type EditorState,
	TextSelection,
	type Transaction,
} from "@tiptap/pm/state";

type Replacement = { from: number; to: number; slice: Slice };

/** The single differing range between two fragments, in their local coordinates. */
function fragmentDiff(
	a: Fragment,
	b: Fragment,
): { start: number; endA: number; endB: number } | null {
	const start = a.findDiffStart(b);
	if (start === null) return null;
	const end = a.findDiffEnd(b);
	let endA = end?.a ?? a.size;
	let endB = end?.b ?? b.size;
	// Repeated content can make the common suffix overlap the common prefix
	// ("aa" -> "aaa"); push the end past the start on both sides.
	const overlap = start - Math.min(endA, endB);
	if (overlap > 0) {
		endA += overlap;
		endB += overlap;
	}
	return { start, endA, endB };
}

/**
 * Collect the replacements that turn `a` into `b`, in `a`'s document
 * coordinates. `contentStart` is where `a`'s content begins in the document.
 */
function collect(
	a: PmNode,
	b: PmNode,
	contentStart: number,
	out: Replacement[],
): void {
	if (!a.isTextblock && a.childCount === b.childCount) {
		let offset = contentStart;
		for (let index = 0; index < a.childCount; index += 1) {
			const left = a.child(index);
			const right = b.child(index);
			if (!left.eq(right)) {
				if (left.sameMarkup(right) && !left.isLeaf) {
					collect(left, right, offset + 1, out);
				} else {
					out.push({
						from: offset,
						to: offset + left.nodeSize,
						slice: new Slice(Fragment.from(right), 0, 0),
					});
				}
			}
			offset += left.nodeSize;
		}
		return;
	}
	const diff = fragmentDiff(a.content, b.content);
	if (!diff) return;
	out.push({
		from: contentStart + diff.start,
		to: contentStart + diff.endA,
		slice: b.slice(diff.start, diff.endB),
	});
}

/**
 * The transaction that moves `state` to `incoming`, or `null` when the editor
 * already shows it. The local selection is carried by the transaction's own
 * mapping; the caller marks it as a remote change (no history, no echo).
 */
export function incomingDocumentTransaction(
	state: EditorState,
	incoming: PmNode,
): Transaction | null {
	const current = state.doc;
	if (current.eq(incoming)) return null;

	const replacements: Replacement[] = [];
	collect(current, incoming, 0, replacements);
	// Last first, so every earlier range keeps its original coordinates.
	replacements.sort((left, right) => right.from - left.from);
	let tr = state.tr;
	try {
		for (const { from, to, slice } of replacements) tr.replace(from, to, slice);
	} catch {
		tr = state.tr;
	}

	if (!tr.doc.eq(incoming)) {
		// A structural change the fine-grained diff could not express: fall back to
		// one replacement of the single differing range, then to the whole body.
		tr = state.tr;
		const diff = fragmentDiff(current.content, incoming.content);
		try {
			if (diff)
				tr.replace(
					diff.start,
					diff.endA,
					incoming.slice(diff.start, diff.endB),
				);
		} catch {
			tr = state.tr;
		}
		if (!tr.doc.eq(incoming)) {
			tr = state.tr.replaceWith(0, current.content.size, incoming.content);
			const size = tr.doc.content.size;
			const { anchor, head } = state.selection;
			tr.setSelection(
				TextSelection.between(
					tr.doc.resolve(Math.min(anchor, size)),
					tr.doc.resolve(Math.min(head, size)),
				),
			);
		}
	}

	// A doc-changing step clears stored marks; keep a pending Bold the user just
	// toggled on an empty caret.
	if (state.storedMarks) tr.setStoredMarks(state.storedMarks);
	return tr;
}
