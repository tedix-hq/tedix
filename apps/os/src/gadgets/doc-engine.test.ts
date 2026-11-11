import { afterEach, describe, expect, it } from "vite-plus/test";
import { createDocEngine, retryLinkedImages } from "./doc-engine";

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
