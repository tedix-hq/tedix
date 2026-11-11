import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	EditorHistoryNotice,
	EditorToolbar,
	EditorToolbarButton,
	EditorToolbarColorButton,
} from "./output-editor-toolbar";

let root: Root;
let host: HTMLDivElement;
afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

describe("output editor toolbar", () => {
	it("retains named native colour input changes, disabled controls and toggle state", () => {
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		const onColor = vi.fn();
		const onClick = vi.fn();
		const onDisabled = vi.fn();
		act(() =>
			root.render(
				<EditorToolbar>
					<EditorToolbarButton label="Bold" active onClick={onClick}>
						B
					</EditorToolbarButton>
					<EditorToolbarButton label="Undo" disabled onClick={onDisabled}>
						U
					</EditorToolbarButton>
					<EditorToolbarColorButton
						label="Text color"
						color="#123456"
						onChange={onColor}
					>
						A
					</EditorToolbarColorButton>
					<EditorToolbarColorButton
						label="Highlight color"
						color="#abcdef"
						disabled
						onChange={onDisabled}
					>
						H
					</EditorToolbarColorButton>
					<EditorHistoryNotice notice="Collaborator changes preserved" />
				</EditorToolbar>,
			),
		);
		const bold = host.querySelector<HTMLButtonElement>('[aria-label="Bold"]')!;
		expect(bold.getAttribute("aria-pressed")).toBe("true");
		act(() => bold.click());
		expect(onClick).toHaveBeenCalledOnce();
		act(() =>
			host.querySelector<HTMLButtonElement>('[aria-label="Undo"]')!.click(),
		);
		expect(onDisabled).not.toHaveBeenCalled();
		const input = host.querySelector<HTMLInputElement>(
			'input[aria-label="Text color"]',
		)!;
		expect(input.type).toBe("color");
		expect(input.value).toBe("#123456");
		act(() => {
			Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)!.set!.call(input, "#654321");
			input.dispatchEvent(new Event("change", { bubbles: true }));
		});
		expect(onColor).toHaveBeenCalledWith("#654321");
		expect(
			host.querySelector<HTMLInputElement>(
				'input[aria-label="Highlight color"]',
			)!.disabled,
		).toBe(true);
		expect(host.querySelector('[role="status"]')!.textContent).toBe(
			"Collaborator changes preserved",
		);
	});
});
