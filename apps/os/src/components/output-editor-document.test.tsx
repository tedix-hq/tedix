import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Editor } from "@tiptap/core";
import { describe, expect, it, vi } from "vite-plus/test";
import { blocksFromRichText, type DocumentContent } from "@/lib/output-models";
import { canonicalJsonText } from "@/lib/diff/canonical-json";
import { MAX_FILE_TEXT_LENGTH } from "@/collab/ot/code-change";
import * as documentImages from "@/lib/document-images";
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

	it("keeps secondary tools available in More without crowding the main toolbar", async () => {
		const mounted = await mountEditor();
		expect(button("Bold", mounted.container)).not.toBeNull();
		expect(button("Link", mounted.container)).not.toBeNull();
		expect(button("Font family")).toBeNull();
		await act(async () => button("More formatting").click());
		for (const label of [
			"Font family",
			"Font size",
			"Image URL",
			"Upload image",
			"Align center",
			"Increase indent",
			"Decrease indent",
			"Clear formatting",
		]) {
			expect(button(label), label).not.toBeNull();
		}
		expect(
			button("Increase indent").disabled ||
				button("Increase indent").getAttribute("aria-disabled") === "true",
		).toBe(true);
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
				content: Array.from({ length: 15 }, () => ({
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
				`<img src="data:image/png;base64,${"A".repeat(600_000)}">`,
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
