import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ConfirmDialog } from "./confirm-dialog";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
});
async function render(
	props: Partial<ComponentProps<typeof ConfirmDialog>> = {},
) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	const onConfirm = vi.fn();
	const onOpenChange = vi.fn();
	await act(async () =>
		root.render(
			<ConfirmDialog
				open
				onOpenChange={onOpenChange}
				title="Delete record?"
				description="This cannot be undone."
				confirmLabel="Delete"
				pendingLabel="Deleting…"
				isPending={false}
				onConfirm={onConfirm}
				{...props}
			/>,
		),
	);
	return { onConfirm, onOpenChange };
}
const button = (name: string) =>
	Array.from(document.querySelectorAll("button")).find(
		(el) => el.textContent === name,
	)!;

describe("ConfirmDialog", () => {
	it("disables confirmation and cancellation while pending, including Escape", async () => {
		const { onConfirm, onOpenChange } = await render({ isPending: true });
		expect(button("Cancel").disabled).toBe(true);
		expect(button("Deleting…").disabled).toBe(true);
		await act(async () => {
			button("Deleting…").click();
			document.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
			);
		});
		expect(onConfirm).not.toHaveBeenCalled();
		expect(onOpenChange).not.toHaveBeenCalled();
	});
	it("renders the error and extra body inside an alertdialog", async () => {
		await render({
			error: new Error("Please retry"),
			children: <p>Extra body</p>,
		});
		const dialog = document.querySelector('[role="alertdialog"]');
		expect(dialog?.textContent).toContain("Extra body");
		expect(dialog?.querySelector('[role="alert"]')?.textContent).toContain(
			"Please retry",
		);
	});
	it("fires once and leaves closing to the mutation owner", async () => {
		const { onConfirm, onOpenChange } = await render();
		await act(async () => button("Delete").click());
		expect(onConfirm).toHaveBeenCalledTimes(1);
		expect(onOpenChange).not.toHaveBeenCalled();
		expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
	});
});
