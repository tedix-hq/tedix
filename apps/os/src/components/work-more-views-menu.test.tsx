import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { WORK_VIEWS, workViewHref } from "@/lib/work-views";

vi.mock("@/components/kumo/link-provider", () => ({
	OsRouterLink: ({
		to,
		search,
		...props
	}: {
		to: string;
		search?: Record<string, string>;
	}) => (
		<a href={search ? `${to}?${new URLSearchParams(search)}` : to} {...props} />
	),
}));

import { WorkMoreViewsMenu } from "./work-more-views-menu";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;

async function openMenu() {
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () => {
		root!.render(<WorkMoreViewsMenu />);
	});
	const trigger = document.querySelector<HTMLButtonElement>(
		'button[aria-label="More views"]',
	);
	expect(trigger).not.toBeNull();
	await act(async () => trigger!.click());
	const menu = document.querySelector<HTMLElement>('[role="menu"]');
	expect(menu).not.toBeNull();
	return { trigger: trigger!, menu: menu! };
}

function key(target: Element, key: string) {
	return act(async () => {
		target.dispatchEvent(
			new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
		);
	});
}

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
});

describe("Work more-views menu", () => {
	it("is one quiet icon button, not a tab bar", async () => {
		const { trigger } = await openMenu();
		expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
		expect(document.querySelector('[role="tablist"]')).toBeNull();
	});

	it("lists every registered Work view with its description, grouped", async () => {
		const { menu } = await openMenu();
		const items = [
			...menu.querySelectorAll<HTMLAnchorElement>('a[role="menuitem"]'),
		];
		expect(items.map((item) => item.getAttribute("href"))).toEqual(
			WORK_VIEWS.map(workViewHref),
		);
		for (const [index, view] of WORK_VIEWS.entries()) {
			expect(items[index]!.textContent).toContain(view.label);
			expect(items[index]!.textContent).toContain(view.description);
		}
		expect(
			[...menu.querySelectorAll('[role="group"] > :first-child')].map(
				(label) => label.textContent,
			),
		).toEqual(["Planning", "Reviews", "Operations", "History"]);
	});

	it("moves focus between views with the arrow keys", async () => {
		const { menu } = await openMenu();
		const items = [
			...menu.querySelectorAll<HTMLAnchorElement>('a[role="menuitem"]'),
		];
		await key(menu, "ArrowDown");
		const first = document.activeElement;
		expect(items).toContain(first);
		await key(first!, "ArrowDown");
		expect(document.activeElement).toBe(
			items[items.indexOf(first as never) + 1],
		);
		await key(document.activeElement!, "ArrowUp");
		expect(document.activeElement).toBe(first);
	});
});
