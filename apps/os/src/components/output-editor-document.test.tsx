import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Editor } from "@tiptap/core";
import { describe, expect, it, vi } from "vite-plus/test";
import { blocksFromRichText, type DocumentContent } from "@/lib/output-models";
import { canonicalJsonText } from "@/lib/diff/canonical-json";
import { MAX_FILE_TEXT_LENGTH } from "@/collab/ot/code-change";
import * as documentImages from "@/lib/document-images";
import * as slideFonts from "@/lib/slide-fonts";
import {
	applyDocumentStyle,
	currentDocumentStyle,
	DOCUMENT_FONT_SIZES_PT,
	DOCUMENT_FONTS,
	fontSizeToPoints,
	pointsToFontSize,
} from "@/lib/document-formatting";
import { DocumentEditor } from "./output-editor-document";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

async function mountEditor(disabled = false) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	const onChange = vi.fn();
	let updateValue: (value: DocumentContent) => void;
	let updateDisabled: (value: boolean) => void;
	function Harness() {
		const [value, setValue] = useState<DocumentContent>({
			kind: "document",
			blocks: [{ type: "paragraph", text: "Hello" }],
		});
		const [isDisabled, setDisabled] = useState(disabled);
		updateValue = setValue;
		updateDisabled = setDisabled;
		return (
			<DocumentEditor
				value={value}
				disabled={isDisabled}
				onChange={(next) => {
					onChange(next);
					setValue(next);
				}}
			/>
		);
	}
	await act(async () => {
		root.render(<Harness />);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	const editor = (
		container.querySelector(".tiptap") as HTMLElement & { editor: Editor }
	).editor;
	return {
		container,
		editor,
		onChange,
		rerender: async (value: DocumentContent, nextDisabled = false) => {
			await act(async () => {
				updateValue(value);
				updateDisabled(nextDisabled);
			});
		},
		unmount: () => {
			act(() => root.unmount());
			container.remove();
		},
	};
}

const button = (label: string, root: ParentNode = document) =>
	root.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;

describe("DocumentEditor", () => {
	it("opening and connection changes do not publish edits or create undo history", async () => {
		const mounted = await mountEditor();
		expect(mounted.onChange).not.toHaveBeenCalled();
		expect(mounted.editor.can().undo()).toBe(false);
		const value: DocumentContent = {
			kind: "document",
			blocks: [{ type: "paragraph", text: "Hello" }],
		};
		await mounted.rerender(value, true);
		await mounted.rerender(value, false);
		expect(mounted.onChange).not.toHaveBeenCalled();
		expect(mounted.editor.can().undo()).toBe(false);
		act(() => {
			mounted.editor.chain().selectAll().toggleBold().run();
		});
		expect(mounted.onChange).toHaveBeenCalledOnce();
		expect(
			mounted.onChange.mock.calls[0]?.[0].richText.content[0].content[0].marks,
		).toContainEqual({ type: "bold" });
		expect(mounted.editor.can().undo()).toBe(true);
		mounted.unmount();
	});

	it("opening a research-sized document does not publish it on connection changes", async () => {
		const mounted = await mountEditor();
		const richText = {
			type: "doc" as const,
			content: Array.from({ length: 243 }, (_, index) => ({
				type: index % 17 === 0 ? "codeBlock" : "paragraph",
				content: [
					{
						type: "text",
						text: `Research section ${index}: ${"evidence ".repeat(40)}`,
					},
				],
			})),
		};
		const value: DocumentContent = {
			kind: "document",
			richText,
			blocks: blocksFromRichText(richText),
		};
		await mounted.rerender(value, true);
		await mounted.rerender(value, false);
		expect(mounted.editor.state.doc.childCount).toBe(243);
		expect(mounted.editor.getText().length).toBeGreaterThan(90_000);
		expect(mounted.onChange).not.toHaveBeenCalled();
		expect(mounted.editor.can().undo()).toBe(false);
		mounted.unmount();
	});

	it("receiving a saved document does not publish it back or add it to local undo history", async () => {
		const mounted = await mountEditor();
		await mounted.rerender({
			kind: "document",
			blocks: [{ type: "paragraph", text: "Received saved version" }],
		});
		expect(mounted.editor.getText()).toBe("Received saved version");
		expect(mounted.onChange).not.toHaveBeenCalled();
		expect(mounted.editor.can().undo()).toBe(false);
		mounted.unmount();
	});

	it("shows every toolbar group when the toolbar is wide", async () => {
		const mounted = await mountEditor();
		for (const label of [
			"Bold",
			"Strikethrough",
			"Font family",
			"Font size",
			"Text color",
			"Align center",
			"Bulleted list",
			"Increase indent",
			"Decrease indent",
			"Link",
			"Upload image",
			"Image URL",
			"Horizontal rule",
			"Clear formatting",
		]) {
			expect(button(label, mounted.container), label).not.toBeNull();
		}
		expect(button("More formatting", mounted.container)).toBeNull();
		mounted.unmount();
	});

	it("folds lower-priority groups into More only as the toolbar narrows", async () => {
		const width = vi
			.spyOn(HTMLElement.prototype, "clientWidth", "get")
			.mockReturnValue(1300);
		const mounted = await mountEditor();
		// 1300px folds only tier 3: indent, inline code, rule and clear.
		expect(button("Font family", mounted.container)).not.toBeNull();
		expect(button("Align center", mounted.container)).not.toBeNull();
		expect(button("Increase indent", mounted.container)).toBeNull();
		await act(async () => button("More formatting").click());
		for (const label of ["Increase indent", "Clear formatting"]) {
			expect(button(label), label).not.toBeNull();
		}
		expect(
			document.querySelectorAll('[aria-label="Font family"]'),
		).toHaveLength(1);
		mounted.unmount();
		width.mockReturnValue(700);
		const narrow = await mountEditor();
		for (const label of ["Font family", "Align center", "Link"]) {
			expect(button(label, narrow.container), label).toBeNull();
		}
		expect(button("Bold", narrow.container)).not.toBeNull();
		expect(button("Paragraph style", narrow.container)).not.toBeNull();
		narrow.unmount();
		width.mockRestore();
	});

	it("applies Title, Quote and Code block styles that round-trip through the saved document", async () => {
		const mounted = await mountEditor();
		await act(async () => {
			mounted.editor.commands.setTextSelection(2);
			applyDocumentStyle(mounted.editor, "title");
		});
		expect(currentDocumentStyle(mounted.editor)).toBe("title");
		let saved = mounted.onChange.mock.lastCall?.[0];
		expect(saved.richText.content[0]).toMatchObject({
			type: "heading",
			attrs: { level: 1, variant: "title" },
		});
		expect(saved.blocks[0]).toEqual({
			type: "heading",
			level: 1,
			text: "Hello",
		});
		expect(mounted.editor.getHTML()).toContain('<h1 class="doc-title">');
		await act(async () => applyDocumentStyle(mounted.editor, "1"));
		expect(currentDocumentStyle(mounted.editor)).toBe("1");
		expect(mounted.editor.getHTML()).toContain("<h1>Hello</h1>");
		await act(async () => applyDocumentStyle(mounted.editor, "quote"));
		expect(currentDocumentStyle(mounted.editor)).toBe("quote");
		saved = mounted.onChange.mock.lastCall?.[0];
		expect(saved.blocks[0]).toEqual({ type: "quote", text: "Hello" });
		await act(async () => applyDocumentStyle(mounted.editor, "code"));
		expect(currentDocumentStyle(mounted.editor)).toBe("code");
		saved = mounted.onChange.mock.lastCall?.[0];
		expect(saved.blocks[0]).toEqual({ type: "code", text: "Hello" });
		await act(async () => applyDocumentStyle(mounted.editor, "paragraph"));
		expect(currentDocumentStyle(mounted.editor)).toBe("paragraph");
		expect(mounted.editor.getHTML()).toMatch(/^<p>Hello<\/p>/);
		mounted.unmount();
	});

	it("indents and outdents any block, not only list items", async () => {
		const mounted = await mountEditor();
		await act(async () => mounted.editor.commands.setTextSelection(2));
		const outdent = button("Decrease indent", mounted.container);
		expect(
			outdent.disabled || outdent.getAttribute("aria-disabled") === "true",
		).toBe(true);
		await act(async () => button("Increase indent", mounted.container).click());
		await act(async () => button("Increase indent", mounted.container).click());
		expect(mounted.editor.getHTML()).toBe(
			'<p style="margin-left: 80px;">Hello</p>',
		);
		expect(
			mounted.onChange.mock.lastCall?.[0].richText.content[0].attrs,
		).toMatchObject({ indent: 2 });
		await act(async () => button("Decrease indent", mounted.container).click());
		await act(async () => button("Decrease indent", mounted.container).click());
		expect(mounted.editor.getHTML()).toBe("<p>Hello</p>");
		mounted.unmount();
	});

	it("offers the six fonts and point sizes stored in the export's pixel unit", async () => {
		const load = vi
			.spyOn(slideFonts, "ensureSlideFontLoaded")
			.mockImplementation(() => {});
		const mounted = await mountEditor();
		expect(DOCUMENT_FONTS.map((font) => font.label)).toEqual([
			"Sans serif",
			"Serif",
			"Mono",
			"Inter",
			"Georgia",
			"Courier",
		]);
		expect(DOCUMENT_FONT_SIZES_PT[0]).toBe(8);
		expect(DOCUMENT_FONT_SIZES_PT.at(-1)).toBe(72);
		expect(pointsToFontSize(12)).toBe("16px");
		expect(pointsToFontSize(8)).toBe("10.67px");
		expect(fontSizeToPoints(pointsToFontSize(8))).toBe(8);
		expect(fontSizeToPoints("24px")).toBe(18);
		expect(fontSizeToPoints("14pt")).toBe(14);
		await act(async () => {
			mounted.editor
				.chain()
				.selectAll()
				.setFontFamily("Inter, sans-serif")
				.setFontSize(pointsToFontSize(18))
				.run();
		});
		expect(load).toHaveBeenCalledWith("Inter, sans-serif");
		load.mockRestore();
		expect(button("Font size", mounted.container).textContent).toContain(
			"18 pt",
		);
		mounted.unmount();
	});

	it("inserts every image picked at once, showing progress while they are prepared", async () => {
		const mounted = await mountEditor();
		// An empty page: each image must land after the one before it.
		await act(async () => {
			mounted.editor.commands.setContent("<p></p>");
			mounted.editor.commands.setTextSelection(1);
		});
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const prepare = vi
			.spyOn(documentImages, "prepareDocumentImage")
			.mockImplementation(async (file: File) => {
				await gate;
				return {
					src: "data:image/png;base64,AAAA",
					width: 100,
					height: 50,
					alt: file.name,
				};
			});
		const input =
			mounted.container.querySelector<HTMLInputElement>('input[type="file"]')!;
		expect(input.multiple).toBe(true);
		Object.defineProperty(input, "files", {
			value: ["one.png", "two.png", "three.png"].map(
				(name) => new File(["image"], name, { type: "image/png" }),
			),
		});
		await act(async () => {
			input.dispatchEvent(new Event("change", { bubbles: true }));
			await Promise.resolve();
		});
		expect(
			mounted.container.querySelector('[role="status"]')?.textContent,
		).toBe("Processing image…");
		await act(async () => {
			release();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		const images = mounted.editor
			.getJSON()
			.content!.filter((node) => node.type === "image");
		expect(images.map((node) => node.attrs?.alt)).toEqual([
			"one.png",
			"two.png",
			"three.png",
		]);
		expect(mounted.container.querySelector('[role="status"]')).toBeNull();
		prepare.mockRestore();
		mounted.unmount();
	});

	it("drops several images at once and ignores non-image files", async () => {
		const mounted = await mountEditor();
		const prepare = vi
			.spyOn(documentImages, "prepareDocumentImage")
			.mockImplementation(async (file: File) => ({
				src: "data:image/png;base64,AAAA",
				width: 100,
				height: 50,
				alt: file.name,
			}));
		const paper = mounted.container.querySelector(
			'[data-kumo-part="document-paper"]',
		)!;
		const drop = new Event("drop", { bubbles: true, cancelable: true });
		Object.defineProperty(drop, "dataTransfer", {
			value: {
				files: [
					new File(["image"], "a.png", { type: "image/png" }),
					new File(["text"], "notes.txt", { type: "text/plain" }),
					new File(["image"], "b.jpg", { type: "image/jpeg" }),
				],
			},
		});
		await act(async () => {
			paper.dispatchEvent(drop);
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(prepare).toHaveBeenCalledTimes(2);
		expect(
			mounted.editor
				.getJSON()
				.content!.filter((node) => node.type === "image")
				.map((node) => node.attrs?.alt),
		).toEqual(["a.png", "b.jpg"]);
		prepare.mockRestore();
		mounted.unmount();
	});

	it("offers an explicit safe destination and removes links without deleting their text", async () => {
		const mounted = await mountEditor();
		await act(async () => {
			mounted.editor.commands.setContent({
				type: "doc",
				content: [
					{
						type: "paragraph",
						content: [
							{
								type: "text",
								text: "Evidence",
								marks: [
									{
										type: "link",
										attrs: { href: "https://example.com/evidence" },
									},
								],
							},
						],
					},
				],
			});
			mounted.editor.commands.setTextSelection(3);
		});
		const open = Array.from(document.querySelectorAll("a")).find(
			(a) => a.textContent === "Open link",
		);
		expect(open?.href).toBe("https://example.com/evidence");
		expect(open?.rel).toContain("noopener");
		expect(open?.target).toBe("_blank");
		const remove = Array.from(document.querySelectorAll("button")).find(
			(b) => b.textContent === "Remove link",
		)!;
		await act(async () => remove.click());
		expect(mounted.editor.getText()).toBe("Evidence");
		expect(mounted.editor.getHTML()).not.toContain("href=");
		mounted.unmount();
	});

	it("keeps authored size and resized image dimensions in the rich document", async () => {
		const mounted = await mountEditor();
		await act(async () => {
			mounted.editor.chain().selectAll().setFontSize("24px").run();
			mounted.editor
				.chain()
				.setTextSelection(6)
				.setImage({
					src: "https://example.com/image.png",
					width: 320,
					height: 160,
				})
				.run();
		});
		const saved = mounted.onChange.mock.lastCall?.[0];
		expect(saved.richText.content[0].content[0].marks).toContainEqual({
			type: "textStyle",
			attrs: { fontFamily: null, fontSize: "24px", color: null },
		});
		expect(
			saved.richText.content.find(
				(node: { type: string }) => node.type === "image",
			).attrs,
		).toMatchObject({ width: 320, height: 160 });
		mounted.unmount();
	});

	it("supports nested list indentation without introducing custom document attributes", async () => {
		const mounted = await mountEditor();
		await act(async () => {
			mounted.editor.commands.setContent(
				"<ul><li><p>One</p></li><li><p>Two</p></li></ul>",
			);
			mounted.editor.commands.setTextSelection(10);
		});
		expect(mounted.editor.can().sinkListItem("listItem")).toBe(true);
		await act(async () => {
			mounted.editor.commands.sinkListItem("listItem");
		});
		expect(mounted.editor.getHTML()).toContain(
			"<li><p>One</p><ul><li><p>Two</p></li></ul></li>",
		);
		mounted.unmount();
	});

	it("receives a saved document above the local safety margin without allowing an oversized local edit", async () => {
		const mounted = await mountEditor();
		let incoming: DocumentContent;
		let length = 0;
		let paragraphLength = 10_000;
		do {
			const richText = mounted.editor.schema
				.nodeFromJSON({
					type: "doc",
					content: Array.from({ length: 20 }, () => ({
						type: "paragraph",
						content: [{ type: "text", text: "R".repeat(paragraphLength) }],
					})),
				})
				.toJSON();
			incoming = {
				kind: "document",
				richText,
				blocks: blocksFromRichText(richText),
			};
			length = canonicalJsonText(incoming).length;
			paragraphLength += 25;
		} while (length < MAX_FILE_TEXT_LENGTH - 3_072);
		expect(length).toBeGreaterThan(MAX_FILE_TEXT_LENGTH - 4_096);
		expect(length).toBeLessThan(MAX_FILE_TEXT_LENGTH);
		await mounted.rerender(incoming);
		expect(mounted.editor.getJSON()).toEqual(incoming.richText);
		expect(mounted.onChange).not.toHaveBeenCalled();
		expect(mounted.editor.can().undo()).toBe(false);
		await act(async () => {
			mounted.editor.commands.insertContent("extra text");
		});
		expect(mounted.editor.getJSON()).toEqual(incoming.richText);
		expect(mounted.onChange).not.toHaveBeenCalled();
		expect(
			mounted.container.querySelector('[role="alert"]')?.textContent,
		).toContain("document is full");
		mounted.unmount();
	});

	it("refuses an image that would exceed the shared document limit without changing the draft", async () => {
		const mounted = await mountEditor();
		await act(async () => {
			mounted.editor.commands.setContent({
				type: "doc",
				content: Array.from({ length: 26 }, () => ({
					type: "paragraph",
					content: [{ type: "text", text: "A".repeat(10_000) }],
				})),
			});
		});
		const before = mounted.editor.getJSON();
		mounted.onChange.mockClear();
		const prepare = vi
			.spyOn(documentImages, "prepareDocumentImage")
			.mockResolvedValue({
				src: "data:image/png;base64," + "A".repeat(256 * 1024 - 30),
				width: 800,
				height: 400,
				alt: "Receipt",
			});
		const input =
			mounted.container.querySelector<HTMLInputElement>('input[type="file"]')!;
		Object.defineProperty(input, "files", {
			value: [new File(["image"], "image.png", { type: "image/png" })],
		});
		await act(async () => {
			input.dispatchEvent(new Event("change", { bubbles: true }));
			await Promise.resolve();
		});
		expect(
			mounted.container.querySelector('[role="alert"]')?.textContent,
		).toContain("document is full");
		expect(mounted.editor.getJSON()).toEqual(before);
		expect(mounted.onChange).not.toHaveBeenCalled();
		prepare.mockRestore();
		mounted.unmount();
	});

	it("rejects oversized HTML images before changing the shared draft while accepting ordinary edits", async () => {
		const mounted = await mountEditor();
		await act(async () => {
			mounted.editor.commands.insertContent(" typed");
		});
		expect(mounted.editor.getText()).toContain("typed");
		const before = mounted.editor.getJSON();
		mounted.onChange.mockClear();
		await act(async () => {
			mounted.editor.commands.insertContent(
				`<img src="data:image/png;base64,${"A".repeat(MAX_FILE_TEXT_LENGTH)}">`,
			);
			await Promise.resolve();
		});
		expect(mounted.editor.getJSON()).toEqual(before);
		expect(mounted.onChange).not.toHaveBeenCalled();
		expect(
			mounted.container.querySelector('[role="alert"]')?.textContent,
		).toContain("document is full");
		mounted.unmount();
	});

	it("disables authoring controls in read-only mode", async () => {
		const mounted = await mountEditor(true);
		for (const control of mounted.container.querySelectorAll<
			HTMLButtonElement | HTMLInputElement
		>("button,input")) {
			expect(
				control.disabled || control.getAttribute("aria-disabled") === "true",
				control.getAttribute("aria-label") ?? "control",
			).toBe(true);
		}
		expect(
			mounted.container.querySelector('[contenteditable="false"]'),
		).not.toBeNull();
		mounted.unmount();
	});
});
