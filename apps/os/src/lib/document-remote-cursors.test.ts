import { getSchema } from "@tiptap/core";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vite-plus/test";
import type { CollabParticipant } from "@/collab/presence";
import {
	REMOTE_CHANGE_META,
	type RemoteCursor,
	remoteCursorsKey,
	remoteCursorsPlugin,
	setRemoteCursors,
} from "./document-remote-cursors";
import { remoteCursorsFromParticipants } from "./use-document-collab";

const schema = getSchema([StarterKit]);

function create() {
	const doc = schema.nodeFromJSON({
		type: "doc",
		content: [
			{ type: "paragraph", content: [{ type: "text", text: "Hello" }] },
			{ type: "paragraph", content: [{ type: "text", text: "World" }] },
		],
	});
	return EditorState.create({
		doc,
		selection: TextSelection.create(doc, 1),
		plugins: [remoteCursorsPlugin()],
	});
}

const ada: RemoteCursor = {
	key: "ada",
	name: "Ada",
	color: "#2563eb",
	anchor: 8,
	head: 12,
};

function tracked(state: EditorState) {
	return remoteCursorsKey.getState(state)!;
}

describe("remote cursors", () => {
	it("draws a named caret at the head and a highlight over the selection", () => {
		const state = create().apply(setRemoteCursors(create().tr, [ada], 1));
		const decorations = tracked(state).decorations.find();
		const highlight = decorations.find((item) => item.from !== item.to);
		const caret = decorations.find((item) => item.from === item.to);
		expect(highlight).toMatchObject({ from: 8, to: 12 });
		expect(caret?.from).toBe(12);
		const element = (
			caret as unknown as { type: { toDOM: () => HTMLElement } }
		).type.toDOM();
		expect(element.textContent).toBe("Ada");
		expect(element.style.getPropertyValue("--collab-color")).toBe("#2563eb");
	});

	it("restarts the idle clock only when a collaborator moves", () => {
		let state = create();
		state = state.apply(setRemoteCursors(state.tr, [ada], 1));
		state = state.apply(setRemoteCursors(state.tr, [{ ...ada }], 2));
		expect(tracked(state).cursors[0]?.movedAt).toBe(1);
		state = state.apply(setRemoteCursors(state.tr, [{ ...ada, head: 9 }], 3));
		expect(tracked(state).cursors[0]?.movedAt).toBe(3);
		state = state.apply(setRemoteCursors(state.tr, [], 4));
		expect(tracked(state).decorations.find()).toHaveLength(0);
	});

	it("maps carets through local edits but not through remote ones", () => {
		let state = create();
		state = state.apply(setRemoteCursors(state.tr, [ada], 1));
		state = state.apply(state.tr.insertText("Hi ", 1));
		expect(tracked(state).cursors[0]).toMatchObject({ anchor: 11, head: 15 });
		state = state.apply(
			state.tr.insertText("x", 1).setMeta(REMOTE_CHANGE_META, true),
		);
		expect(tracked(state).cursors[0]).toMatchObject({ anchor: 11, head: 15 });
	});

	it("clamps a stale position into the document", () => {
		let state = create();
		state = state.apply(
			setRemoteCursors(state.tr, [{ ...ada, anchor: 500, head: 500 }], 1),
		);
		const [caret] = tracked(state).decorations.find();
		expect(caret?.from).toBeLessThanOrEqual(state.doc.content.size);
	});

	it("reads only rich-text selections in the shared document from presence", () => {
		const participant = (
			key: string,
			selection: CollabParticipant["selection"],
		): CollabParticipant => ({
			key,
			displayName: key,
			kind: "human",
			role: "member",
			verified: true,
			clientIds: [1],
			location: null,
			selection,
			sessions: 1,
		});
		const cursors = remoteCursorsFromParticipants([
			participant("rich", {
				path: "document",
				anchor: 2,
				head: 4,
				space: "rich-text",
			}),
			participant("text", { path: "document", anchor: 2, head: 4 }),
			participant("none", null),
		]);
		expect(cursors).toEqual([
			expect.objectContaining({ key: "rich", anchor: 2, head: 4 }),
		]);
	});
});
