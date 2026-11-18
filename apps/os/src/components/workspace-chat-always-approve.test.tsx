import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { AlwaysApproveButton } from "./workspace-chat-always-approve";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
});

const rule = {
	kind: "files" as const,
	label: "creating and editing docs, sheets and slides in this workspace",
};

async function render(disabled = false) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	const onConfirm = vi.fn();
	await act(async () =>
		root.render(
			<AlwaysApproveButton
				rule={rule}
				disabled={disabled}
				onConfirm={onConfirm}
			/>,
		),
	);
	return { onConfirm };
}

const button = (name: string) =>
	Array.from(document.querySelectorAll("button")).find(
		(el) => el.textContent === name,
	);
const dialog = () => document.querySelector('[role="alertdialog"]');

describe("AlwaysApproveButton", () => {
	it("asks first, naming exactly what will be approved without asking", async () => {
		const { onConfirm } = await render();
		expect(dialog()).toBeNull();
		await act(async () => button("Always approve…")?.click());
		const text = dialog()?.textContent ?? "";
		expect(text).toContain("Always approve this kind of change?");
		expect(text).toContain(
			"From now on, creating and editing docs, sheets and slides in this workspace is approved without asking.",
		);
		expect(text).toContain(
			"Deleting, sharing and anything outside this workspace still wait for you.",
		);
		expect(onConfirm).not.toHaveBeenCalled();
	});

	it("turns the rule on only when confirmed", async () => {
		const { onConfirm } = await render();
		await act(async () => button("Always approve…")?.click());
		await act(async () => button("Cancel")?.click());
		expect(onConfirm).not.toHaveBeenCalled();
		await act(async () => button("Always approve…")?.click());
		await act(async () => button("Always approve")?.click());
		expect(onConfirm).toHaveBeenCalledExactlyOnceWith("files");
	});

	it("cannot be opened once the card is decided", async () => {
		await render(true);
		expect(button("Always approve…")?.disabled).toBe(true);
	});
});
