import { getSchema } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { history, undo } from "@tiptap/pm/history";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vite-plus/test";
import { incomingDocumentTransaction } from "./document-remote-merge";

const schema = getSchema([StarterKit.configure({ undoRedo: false })]);

function paragraph(text: string) {
	return text
		? { type: "paragraph", content: [{ type: "text", text }] }
		: { type: "paragraph" };
}

function doc(...content: object[]): PmNode {
	return schema.nodeFromJSON({ type: "doc", content });
}

/** Position just after `text` inside the document. */
function after(node: PmNode, text: string): number {
	let found = -1;
	node.descendants((child, pos) => {
		if (found >= 0 || !child.isText) return;
		const index = child.text?.indexOf(text) ?? -1;
		if (index >= 0) found = pos + index + text.length;
	});
	if (found < 0) throw new Error(`missing ${text}`);
	return found;
}

function stateAt(node: PmNode, anchor: number, head = anchor) {
	return EditorState.create({
		doc: node,
		selection: TextSelection.create(node, anchor, head),
		plugins: [history()],
	});
}

function apply(state: EditorState, incoming: PmNode) {
	const tr = incomingDocumentTransaction(state, incoming);
	expect(tr).not.toBeNull();
	const next = state.apply(tr!.setMeta("addToHistory", false));
	expect(next.doc.eq(incoming)).toBe(true);
	return next;
}

describe("incomingDocumentTransaction", () => {
	it("returns null when the editor already shows the incoming document", () => {
		const current = doc(paragraph("One"));
		expect(
			incomingDocumentTransaction(stateAt(current, 1), doc(paragraph("One"))),
		).toBeNull();
	});

	it("keeps the caret where it was when a peer types in another paragraph", () => {
		const current = doc(paragraph("Mine here"), paragraph("Theirs"));
		const caret = after(current, "Mine");
		const incoming = doc(paragraph("Mine here"), paragraph("Theirs typed"));
		const next = apply(stateAt(current, caret), incoming);
		expect(next.selection.head).toBe(caret);
		expect(next.doc.textBetween(1, next.selection.head)).toBe("Mine");
	});

	it("shifts the caret with text a peer inserts earlier in the document", () => {
		const current = doc(paragraph("Intro"), paragraph("Mine"));
		const caret = after(current, "Mine");
		const incoming = doc(paragraph("Intro and more"), paragraph("Mine"));
		const next = apply(stateAt(current, caret), incoming);
		expect(next.selection.head).toBe(after(next.doc, "Mine"));
	});

	it("keeps the caret when a peer edits the same paragraph on both sides of it in one change", () => {
		const current = doc(
			paragraph("Alpha"),
			paragraph("Beta"),
			paragraph("Gamma"),
		);
		const caret = after(current, "Beta");
		const incoming = doc(
			paragraph("Alpha!"),
			paragraph("Beta"),
			paragraph("Gamma!"),
		);
		const next = apply(stateAt(current, caret), incoming);
		expect(next.selection.head).toBe(after(next.doc, "Beta"));
	});

	it("maps a range selection across a peer's new paragraph above it", () => {
		const current = doc(paragraph("Top"), paragraph("Select me"));
		const from = after(current, "Select") - "Select".length;
		const to = after(current, "Select me");
		const incoming = doc(
			paragraph("Top"),
			paragraph("New"),
			paragraph("Select me"),
		);
		const next = apply(stateAt(current, from, to), incoming);
		expect(next.doc.textBetween(next.selection.from, next.selection.to)).toBe(
			"Select me",
		);
	});

	it("applies a peer's list edit without touching the local caret", () => {
		const list = (...items: string[]) => ({
			type: "bulletList",
			content: items.map((text) => ({
				type: "listItem",
				content: [paragraph(text)],
			})),
		});
		const current = doc(list("first", "second"), paragraph("Mine"));
		const caret = after(current, "Mine");
		const incoming = doc(list("first", "second", "third"), paragraph("Mine"));
		const next = apply(stateAt(current, caret), incoming);
		expect(next.selection.head).toBe(after(next.doc, "Mine"));
	});

	it("keeps a mark the user toggled on an empty caret", () => {
		const current = doc(paragraph("Mine"), paragraph("Theirs"));
		const state = stateAt(current, after(current, "Mine"));
		const bold = schema.marks.bold!.create();
		const marked = state.apply(state.tr.setStoredMarks([bold]));
		const next = apply(marked, doc(paragraph("Mine"), paragraph("Theirs!")));
		expect(next.storedMarks).toEqual([bold]);
	});

	it("keeps undo to the user's own edits", () => {
		const current = doc(paragraph("Mine"), paragraph("Theirs"));
		let state = stateAt(current, after(current, "Mine"));
		state = state.apply(state.tr.insertText(" typed"));
		state = apply(state, doc(paragraph("Mine typed"), paragraph("Theirs too")));
		let undone: EditorState | null = null;
		undo(state, (tr) => {
			undone = state.apply(tr);
		});
		expect(undone).not.toBeNull();
		expect((undone as unknown as EditorState).doc.toJSON()).toEqual(
			doc(paragraph("Mine"), paragraph("Theirs too")).toJSON(),
		);
	});

	it("replaces a wholly different document", () => {
		const current = doc(paragraph("Old"), paragraph("Text"));
		const incoming = doc({
			type: "heading",
			attrs: { level: 1 },
			content: [{ type: "text", text: "New" }],
		});
		apply(stateAt(current, 3), incoming);
	});
});
