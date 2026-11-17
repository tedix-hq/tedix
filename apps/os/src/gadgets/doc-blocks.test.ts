import { afterEach, describe, expect, it } from "vite-plus/test";
import { createDocEngine } from "./doc-engine";
import {
	blockSelection,
	blockSelectionKey,
	blockSelectionPlugin,
	deleteUnit,
	moveUnit,
	unitAt,
} from "./doc-blocks";

afterEach(() => document.body.replaceChildren());

const paragraph = (text: string) => ({
	type: "paragraph",
	content: [{ type: "text", text }],
});
function setup(content: object[]) {
	const element = document.body.appendChild(document.createElement("div"));
	const editor = createDocEngine({
		element,
		editable: true,
		onUpdate: () => undefined,
	});
	editor.registerPlugin(blockSelectionPlugin());
	editor.commands.setContent({ type: "doc", content } as never);
	return editor;
}
/** Where `text` is in the document. */
function at(editor: ReturnType<typeof setup>, text: string) {
	let found = -1;
	editor.state.doc.descendants((node, pos) => {
		if (found < 0 && node.isText && node.text === text) found = pos + 1;
	});
	return found;
}
const press = (key: string, init: KeyboardEventInit = {}) =>
	new KeyboardEvent("keydown", { key, ...init });

describe("block units", () => {
	it("treats a list item as its own block and moves it within its list", () => {
		const editor = setup([
			{
				type: "bulletList",
				content: ["One", "Two", "Three"].map((text) => ({
					type: "listItem",
					content: [paragraph(text)],
				})),
			},
		]);
		const third = unitAt(editor, at(editor, "Three"))!;
		expect(third.node.type.name).toBe("listItem");
		expect(moveUnit(editor, third, 0)).toBe(true);
		const items: string[] = [];
		editor.state.doc.descendants((node) => {
			if (node.type.name === "listItem") items.push(node.textContent);
		});
		expect(items).toEqual(["Three", "One", "Two"]);
		// Deleting the only item takes its list with it.
		const list = setup([
			paragraph("Keep"),
			{
				type: "bulletList",
				content: [{ type: "listItem", content: [paragraph("Gone")] }],
			},
		]);
		deleteUnit(list, unitAt(list, at(list, "Gone"))!);
		expect(JSON.stringify(list.getJSON())).not.toContain("bulletList");
		expect(list.state.doc.firstChild!.textContent).toBe("Keep");
	});
});

describe("block selection", () => {
	it("selects with Esc, extends with Shift+arrow, moves and deletes blocks", () => {
		const editor = setup(["A", "B", "C", "D"].map(paragraph));
		editor.commands.setTextSelection(4);
		expect(blockSelectionKey(editor, press("Escape"))).toBe(true);
		expect(blockSelection(editor)).toEqual({ from: 1, to: 1 });
		blockSelectionKey(editor, press("ArrowDown", { shiftKey: true }));
		expect(blockSelection(editor)).toEqual({ from: 1, to: 2 });
		blockSelectionKey(
			editor,
			press("ArrowUp", { shiftKey: true, altKey: true }),
		);
		expect(editor.getText()).toBe("B\n\nC\n\nA\n\nD");
		expect(blockSelection(editor)).toEqual({ from: 0, to: 1 });
		blockSelectionKey(editor, press("Backspace"));
		expect(editor.getText()).toBe("A\n\nD");
		expect(blockSelection(editor)).toBeNull();
	});
	it("duplicates with Cmd+D, selects all with Cmd+A and goes back to text on Enter", () => {
		const editor = setup(["A", "B"].map(paragraph));
		editor.commands.setTextSelection(1);
		blockSelectionKey(editor, press("Escape"));
		blockSelectionKey(editor, press("d", { metaKey: true }));
		expect(editor.getText()).toBe("A\n\nA\n\nB");
		blockSelectionKey(editor, press("a", { metaKey: true }));
		expect(blockSelection(editor)).toEqual({ from: 0, to: 2 });
		blockSelectionKey(editor, press("Enter"));
		expect(blockSelection(editor)).toBeNull();
	});
});
