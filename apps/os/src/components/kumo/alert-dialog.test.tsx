// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "./alert-dialog";

describe("Kumo AlertDialog adapter", () => {
	it("renders an alertdialog whose confirm and cancel controls both close it", async () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		const onOpenChange = vi.fn();
		const onConfirm = vi.fn();

		await act(async () =>
			root.render(
				<AlertDialog open onOpenChange={onOpenChange}>
					<AlertDialogContent size="sm">
						<AlertDialogHeader>
							<AlertDialogTitle>Remove member?</AlertDialogTitle>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>Cancel</AlertDialogCancel>
							<AlertDialogAction onClick={onConfirm}>Remove</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>,
			),
		);

		const dialog = document.querySelector('[role="alertdialog"]');
		expect(dialog).not.toBeNull();
		expect(dialog?.className).toContain("sm:max-w-md");
		// Alerts require an explicit choice: no corner close button.
		expect(dialog?.querySelector('button[aria-label="Close"]')).toBeNull();

		const button = (name: string) =>
			[...document.querySelectorAll<HTMLButtonElement>("button")].find(
				(candidate) => candidate.textContent === name,
			);
		await act(async () => button("Remove")?.click());
		expect(onConfirm).toHaveBeenCalledTimes(1);
		expect(onOpenChange).toHaveBeenLastCalledWith(false, expect.anything());

		await act(async () => button("Cancel")?.click());
		expect(onOpenChange).toHaveBeenCalledTimes(2);

		await act(async () => root.unmount());
		host.remove();
	});
});
