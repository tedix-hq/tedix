import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";
import { EditorTextDialog } from "./editor-text-dialog";
import { DocumentEditor } from "./output-editor-document";
import { SheetEditor } from "./output-editor-sheet";
import { SlidesEditor } from "./output-editor-slides";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

async function setInputValue(input: HTMLInputElement, value: string) {
	const setter = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value",
	)?.set;
	if (!setter) throw new Error("input value setter missing");
	await act(async () => {
		setter.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
		await Promise.resolve();
	});
}

describe("output editor text dialogs", () => {
	it("asks for text with the Kumo dialog, never a browser prompt", async () => {
		const prompt = vi.fn(() => {
			throw new Error("window.prompt must not be used");
		});
		vi.stubGlobal("prompt", prompt);
		const mountEditor = async (element: React.ReactElement) => {
			const container = document.createElement("div");
			document.body.appendChild(container);
			const root = createRoot(container);
			await act(async () => {
				root.render(element);
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			return {
				container,
				cleanup: () => {
					act(() => root.unmount());
					container.remove();
				},
			};
		};
		const dialogTitle = () =>
			document.querySelector(
				'[role="dialog"] h2, [role="dialog"] [data-slot="dialog-title"]',
			)?.textContent;

		// Document: the link control.
		const document_ = await mountEditor(
			<DocumentEditor
				value={{
					kind: "document",
					blocks: [{ type: "paragraph", text: "Hello" }],
				}}
				onChange={() => {}}
			/>,
		);
		await act(async () =>
			document_.container
				.querySelector<HTMLElement>('[aria-label="Link"]')!
				.click(),
		);
		expect(dialogTitle()).toBe("Edit link");
		document_.cleanup();

		// Spreadsheet: renaming a column.
		const sheet = await mountEditor(
			<SheetEditor
				value={{ kind: "sheet", columns: ["Deal"], rows: [["Acme"]] }}
				onChange={() => {}}
			/>,
		);
		await act(async () =>
			sheet.container
				.querySelector<HTMLElement>(".sheet-editor-column-button")!
				.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
		);
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
		sheet.cleanup();

		// Slides: inserting an image element.
		const slides = await mountEditor(
			<SlidesEditor
				value={{ kind: "presentation", slides: [{ title: "Q3", bullets: [] }] }}
				onChange={() => {}}
			/>,
		);
		const insert = slides.container.querySelector<HTMLElement>(
			'[aria-label="Insert slide element"]',
		)!;
		await act(async () => {
			insert.click();
			await Promise.resolve();
		});
		const image = [
			...document.querySelectorAll<HTMLElement>('[role="option"]'),
		].find((option) => /image/i.test(option.textContent ?? ""))!;
		await act(async () => {
			image.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
			image.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
			image.click();
			await Promise.resolve();
		});
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
		slides.cleanup();

		expect(prompt).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});

	it("uses an accessible Kumo dialog and submits the trimmed TanStack Form value", async () => {
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		const onSubmit = vi.fn();
		const onOpenChange = vi.fn();
		await act(async () => {
			root.render(
				<EditorTextDialog
					open
					title="Insert image"
					description="Add an image from a URL."
					fieldLabel="Image URL"
					initialValue="https://"
					submitLabel="Insert"
					maxLength={2_048}
					onOpenChange={onOpenChange}
					onSubmit={onSubmit}
				/>,
			);
			await Promise.resolve();
		});

		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
		expect(document.body.textContent).toContain("Insert image");
		const input = document.querySelector<HTMLInputElement>(
			'input[name="value"]',
		);
		if (!input) throw new Error("dialog field missing");
		expect(input.getAttribute("aria-labelledby")).toBeTruthy();
		await setInputValue(input, "  https://example.com/image.png  ");
		const submit = Array.from(document.querySelectorAll("button")).find(
			(button) => button.textContent === "Insert",
		);
		await act(async () => {
			submit?.click();
			await Promise.resolve();
		});
		expect(onSubmit).toHaveBeenCalledWith("https://example.com/image.png");
		expect(onOpenChange).toHaveBeenCalledWith(false);

		act(() => root.unmount());
		container.remove();
	});
});
