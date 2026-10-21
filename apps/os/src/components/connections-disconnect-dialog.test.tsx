import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { DisconnectConnectionDialog } from "./connections-disconnect-dialog";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
});
const button = (name: string) =>
	Array.from(document.querySelectorAll("button")).find(
		(el) => el.textContent === name,
	);

it("keeps a failed disconnect inside the dialog with a retry", async () => {
	const onConfirm = vi.fn();
	const onCancel = vi.fn();
	const target = {
		appId: "app-1",
		providerName: "Fixture",
		tokenScope: "user" as const,
	};
	const view = (state: { isPending: boolean; error?: unknown }) => (
		<DisconnectConnectionDialog
			target={target}
			isPending={state.isPending}
			error={state.error}
			onCancel={onCancel}
			onConfirm={onConfirm}
		/>
	);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root.render(view({ isPending: false })));
	await act(async () => button("Disconnect")!.click());
	expect(onConfirm).toHaveBeenCalledTimes(1);
	expect(onCancel).not.toHaveBeenCalled();
	// The owner keeps the target while the mutation runs and then fails.
	await act(async () => root.render(view({ isPending: true })));
	await act(async () =>
		root.render(
			view({ isPending: false, error: new Error("Provider refused") }),
		),
	);
	const dialog = document.querySelector('[role="alertdialog"]');
	expect(dialog).not.toBeNull();
	expect(dialog?.querySelector("[data-confirm-error]")?.textContent).toContain(
		"Provider refused",
	);
	expect(button("Try again")).toBeDefined();
});
