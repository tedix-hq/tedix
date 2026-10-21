import { act } from "react";
import { createRoot } from "react-dom/client";
import { Receipt } from "@phosphor-icons/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { FocusRowActions } from "./focus-row-actions";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
});
it("preserves per-row disclosure state and targets in Kumo phone menus and passes a live return trigger", async () => {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	const clicks = [vi.fn(), vi.fn()];
	await act(async () =>
		root.render(
			<>
				{clicks.map((onClick, index) => (
					<FocusRowActions
						key={index}
						actions={[
							{
								label: "Receipt",
								Icon: Receipt,
								expanded: index === 1,
								controls: `receipt-${index}`,
								onClick,
							},
						]}
					/>
				))}
			</>,
		),
	);
	const tools = [...host.querySelectorAll(".focus-row-tools")];
	for (let index = 0; index < 2; index++) {
		const desktop = tools[index]!.querySelector<HTMLButtonElement>(
			'[aria-label="Receipt"]',
		)!;
		expect(desktop.getAttribute("aria-controls")).toBe(`receipt-${index}`);
		expect(desktop.getAttribute("aria-expanded")).toBe(String(index === 1));
		const more = tools[index]!.querySelector<HTMLButtonElement>(
			'[aria-label="More actions"]',
		)!;
		await act(async () => more.click());
		const menuItem = document.querySelector<HTMLElement>('[role="menuitem"]')!;
		expect(menuItem.getAttribute("aria-controls")).toBe(`receipt-${index}`);
		expect(menuItem.getAttribute("aria-expanded")).toBe(String(index === 1));
		await act(async () => menuItem.click());
		expect(clicks[index]).toHaveBeenCalledExactlyOnceWith(more);
		expect(more.isConnected).toBe(true);
	}
});
it("keeps ordinary and disabled actions unchanged on desktop", async () => {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	const onClick = vi.fn();
	await act(async () =>
		root.render(
			<FocusRowActions
				actions={[
					{ label: "Run", Icon: Receipt, onClick },
					{ label: "Disabled", Icon: Receipt, onClick, disabled: true },
				]}
			/>,
		),
	);
	const run = host.querySelector<HTMLButtonElement>('[aria-label="Run"]')!;
	expect(run.hasAttribute("aria-expanded")).toBe(false);
	expect(run.hasAttribute("aria-controls")).toBe(false);
	await act(async () => {
		run.click();
		host.querySelector<HTMLButtonElement>('[aria-label="Disabled"]')!.click();
	});
	expect(onClick).toHaveBeenCalledExactlyOnceWith(run);
});
