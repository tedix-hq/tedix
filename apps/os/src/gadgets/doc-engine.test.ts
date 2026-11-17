import { afterEach, describe, expect, it } from "vite-plus/test";
import {
	createDocEngine,
	landedRanges,
	retryLinkedImages,
	showLanded,
} from "./doc-engine";
import {
	deleteDocumentBlock,
	duplicateDocumentBlock,
	moveDocumentBlockTo,
} from "@/lib/document-formatting";

afterEach(() => document.body.replaceChildren());

describe("linked images in the Doc editor", () => {
	it("draws a web image from its embedded copy and keeps the link in the document", async () => {
		const link = "https://example.test/picture.png";
		const copy = "data:image/png;base64,AAAA";
		let fail = true;
		const calls: string[] = [];
		const element = document.body.appendChild(document.createElement("div"));
		const editor = createDocEngine({
			element,
			editable: true,
			onUpdate: () => undefined,
			readImage: async (url) => {
				calls.push(url);
				if (fail) throw new Error("not saved yet");
				return copy;
			},
		});
		editor.commands.setContent({
			type: "doc",
			content: [{ type: "image", attrs: { src: link } }],
		});
		const image = () => element.querySelector("img")!;
		// Nothing the frame would block is put on screen.
		expect(image().getAttribute("src")).toMatch(/^data:image\/gif/);
		expect(image().dataset.linkedImage).toBe(link);
		await Promise.resolve();
		await Promise.resolve();
		expect(image().getAttribute("src")).toMatch(/^data:image\/gif/);

		fail = false;
		retryLinkedImages();
		await Promise.resolve();
		await Promise.resolve();
		expect(image().getAttribute("src")).toBe(copy);
		expect(calls).toEqual([link, link]);
		expect(JSON.stringify(editor.getJSON())).toContain(link);
		expect(JSON.stringify(editor.getJSON())).not.toContain(copy);
		editor.destroy();
	});
});

describe("what someone else removed", () => {
	const editorWith = (...texts: string[]) => {
		const element = document.body.appendChild(document.createElement("div"));
		const editor = createDocEngine({
			element,
			editable: true,
			onUpdate: () => undefined,
		});
		const doc = (values: string[]) => ({
			type: "doc",
			content: values.map((text) => ({
				type: "paragraph",
				content: [{ type: "text", text }],
			})),
		});
		editor.commands.setContent(doc(texts));
		return { editor, element, doc };
	};
	it("marks the spot where words were taken out of a paragraph", () => {
		const { editor, element, doc } = editorWith("Ship on Friday at noon");
		const before = editor.state.doc;
		editor.commands.setContent(doc(["Ship on Friday"]));
		const ranges = landedRanges(before, editor.state.doc);
		expect(ranges).toEqual([
			{ from: 15, to: 15, words: true, removed: "text" },
		]);
		showLanded(editor, ranges);
		expect(element.querySelector(".doc-removed")).not.toBeNull();
	});
	it("marks the gap a removed paragraph left", () => {
		const { editor, element, doc } = editorWith("One", "Two", "Three");
		const before = editor.state.doc;
		editor.commands.setContent(doc(["One", "Three"]));
		const ranges = landedRanges(before, editor.state.doc);
		expect(ranges.map((range) => range.removed)).toEqual(["block"]);
		showLanded(editor, ranges);
		expect(element.querySelector(".doc-removed-block")).not.toBeNull();
	});
});

describe("moving, copying and removing whole blocks", () => {
	const setup = (...texts: string[]) => {
		const element = document.body.appendChild(document.createElement("div"));
		const editor = createDocEngine({
			element,
			editable: true,
			onUpdate: () => undefined,
		});
		editor.commands.setContent({
			type: "doc",
			content: texts.map((text) => ({
				type: "paragraph",
				content: [{ type: "text", text }],
			})),
		});
		const texts_ = () =>
			editor.state.doc.content.content.map((node) => node.textContent);
		return { editor, texts: texts_ };
	};
	it("moves a block before another, or to the end", () => {
		const { editor, texts } = setup("One", "Two", "Three");
		expect(moveDocumentBlockTo(editor, 2, 0)).toBe(true);
		expect(texts()).toEqual(["Three", "One", "Two"]);
		expect(moveDocumentBlockTo(editor, 0, 3)).toBe(true);
		expect(texts()).toEqual(["One", "Two", "Three"]);
		// Dropping a block where it already is changes nothing.
		expect(moveDocumentBlockTo(editor, 1, 2)).toBe(false);
	});
	it("duplicates and deletes a block, keeping one empty block at least", () => {
		const { editor, texts } = setup("Only");
		duplicateDocumentBlock(editor, 0);
		expect(texts()).toEqual(["Only", "Only"]);
		deleteDocumentBlock(editor, 0);
		deleteDocumentBlock(editor, 0);
		expect(texts()).toEqual([""]);
	});
});
