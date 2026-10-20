// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "./dialog";

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	root = null;
	host = null;
});

async function render(node: React.ReactNode) {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => root?.render(node));
}

describe("Kumo LayerDialog adapter", () => {
	it("labels the dialog from its title and description and portals on the overlay rung", async () => {
		await render(
			<Dialog open>
				<DialogContent size="lg">
					<DialogHeader>
						<DialogTitle>Rename conversation</DialogTitle>
						<DialogDescription>Pick a short name.</DialogDescription>
					</DialogHeader>
					<DialogFooter>footer</DialogFooter>
				</DialogContent>
			</Dialog>,
		);

		const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
		expect(dialog).not.toBeNull();
		const title = document.getElementById(
			dialog?.getAttribute("aria-labelledby") ?? "",
		);
		expect(title?.textContent).toBe("Rename conversation");
		const description = document.getElementById(
			dialog?.getAttribute("aria-describedby") ?? "",
		);
		expect(description?.textContent).toBe("Pick a short name.");
		expect(dialog?.className).toContain("sm:max-w-2xl");
		expect(
			document.querySelector('[data-slot="dialog-backdrop"]')?.className,
		).toContain("z-(--tedix-layer-overlay)");
		expect(
			document.querySelector('[role="dialog"] button[aria-label="Close"]'),
		).not.toBeNull();
	});

	it("omits the close button on request and opens from a trigger", async () => {
		await render(
			<Dialog>
				<DialogTrigger>Open</DialogTrigger>
				<DialogContent showCloseButton={false}>
					<DialogTitle>Plain</DialogTitle>
				</DialogContent>
			</Dialog>,
		);

		expect(document.querySelector('[role="dialog"]')).toBeNull();
		await act(async () => {
			document.querySelector<HTMLButtonElement>("button")?.click();
		});
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
		expect(
			document.querySelector('[role="dialog"] button[aria-label="Close"]'),
		).toBeNull();
	});
});
