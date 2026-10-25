import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { WORK_VIEWS, workViewHref } from "@/lib/work-views";

const route = vi.hoisted(() => ({
	pathname: "/work",
	search: {} as Record<string, unknown>,
}));

vi.mock("@tanstack/react-router", () => ({
	useRouterState: ({
		select,
	}: {
		select: (state: { location: typeof route }) => unknown;
	}) => select({ location: route }),
}));

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
		'button[aria-haspopup="menu"]',
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
	route.pathname = "/work";
	route.search = {};
});

describe("Work more-views menu", () => {
	it.each(WORK_VIEWS)("exposes the active $label view", async (view) => {
		route.pathname = view.to;
		route.search = { ...view.search, source: "review" };
		const { trigger, menu } = await openMenu();
		expect(trigger.textContent).toBe(view.label);
		expect(trigger.getAttribute("aria-label")).toBe(
			`More views: ${view.label}`,
		);
		expect(trigger.getAttribute("data-active")).toBe("true");
		const current = menu.querySelectorAll('[aria-current="page"]');
		expect(current).toHaveLength(1);
		expect(current[0]!.getAttribute("data-work-view")).toBe(view.id);
	});

	it.each(["/work/cases/", "/work/cases/cedar-case"])(
		"keeps Work streams active at %s",
		async (pathname) => {
			route.pathname = pathname;
			const { trigger, menu } = await openMenu();
			expect(trigger.textContent).toBe("Work streams");
			expect(
				menu
					.querySelector('[aria-current="page"]')
					?.getAttribute("data-work-view"),
			).toBe("cases");
		},
	);

	it("matches an app before leftover feed filters", async () => {
		route.search = { app: "office", view: "feed", filter: "history" };
		const { trigger } = await openMenu();
		expect(trigger.textContent).toBe("Office");
	});

	it.each(["/work", "/work/cases-other", "/work/items/cedar-item"])(
		"has no secondary selection at %s",
		async (pathname) => {
			route.pathname = pathname;
			const { trigger, menu } = await openMenu();
			expect(trigger.getAttribute("aria-label")).toBe("More views");
			expect(trigger.hasAttribute("data-active")).toBe(false);
			expect(menu.querySelector('[aria-current="page"]')).toBeNull();
		},
	);

	it("updates context when navigating back to a primary view", async () => {
		route.pathname = "/work/cases";
		const { trigger } = await openMenu();
		expect(trigger.textContent).toBe("Work streams");
		route.pathname = "/work";
		route.search = { view: "deck" };
		await act(async () => root!.render(<WorkMoreViewsMenu />));
		expect(trigger.textContent).toBe("");
		expect(trigger.getAttribute("aria-label")).toBe("More views");
		expect(trigger.hasAttribute("data-active")).toBe(false);
		expect(document.querySelector('[aria-current="page"]')).toBeNull();
	});

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

	it("moves focus between views and returns to the trigger on Escape", async () => {
		route.pathname = "/work/cases";
		const { trigger, menu } = await openMenu();
		const items = [
			...menu.querySelectorAll<HTMLAnchorElement>('a[role="menuitem"]'),
		];
		await key(menu, "ArrowDown");
		const first = document.activeElement;
		expect(items).toContain(first);
		await key(first!, "ArrowDown");
		expect(document.activeElement).toBe(
			items[items.indexOf(first as HTMLAnchorElement) + 1],
		);
		await key(document.activeElement!, "ArrowUp");
		expect(document.activeElement).toBe(first);
		await key(first!, "Escape");
		expect(document.querySelector('[role="menu"]')).toBeNull();
		expect(document.activeElement).toBe(trigger);
	});
});
