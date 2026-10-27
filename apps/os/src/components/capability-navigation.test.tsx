import { describe, expect, it } from "vite-plus/test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import {
	CapabilityNavigation,
	CAPABILITY_NAV_ITEMS,
	CAPABILITY_SUB_NAV_ITEMS,
	type CapabilityView,
} from "./capability-navigation";

const cleanups: Array<() => void> = [];

async function renderNavigation(active: CapabilityView) {
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
	const rootRoute = createRootRoute({
		component: () => <CapabilityNavigation active={active} />,
	});
	const routes = [
		"/apps",
		"/explore/apps",
		"/skills",
		"/admin/connections",
		"/account/connections",
	].map((path) =>
		createRoute({
			getParentRoute: () => rootRoute,
			path,
			component: () => null,
		}),
	);
	const router = createRouter({
		routeTree: rootRoute.addChildren(routes),
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	cleanups.push(() => {
		act(() => root.unmount());
		container.remove();
	});
	await act(async () => {
		root.render(<RouterProvider router={router} />);
		await router.load();
	});
	return container;
}

function nav(container: HTMLElement, attribute: string) {
	const element = container.querySelector(`[${attribute}]`);
	if (!element) throw new Error(`Missing ${attribute}`);
	return element;
}

describe("CapabilityNavigation", () => {
	it("keeps the shared capability destinations in their stable order", () => {
		expect(CAPABILITY_NAV_ITEMS.map((item) => item.id)).toEqual([
			"apps",
			"accounts",
			"skills",
		]);
		expect(
			Object.values(CAPABILITY_SUB_NAV_ITEMS).flatMap((views) =>
				views.map((view) => view.to),
			),
		).toEqual([
			"/apps",
			"/explore/apps",
			"/admin/connections",
			"/account/connections",
		]);
	});

	it.each([
		["installed", "Apps", "In use"],
		["browse", "Apps", "Browse and add"],
		["organization", "Accounts", "Organization"],
		["personal", "Accounts", "Only you"],
	] as const)(
		"marks the %s view inside its tab",
		async (view, tab, current) => {
			const container = await renderNavigation(view);
			expect(
				[...container.querySelectorAll('[aria-current="page"]')].map(
					(link) => link.textContent,
				),
			).toEqual([tab, current]);
		},
	);

	it("marks the skills tab without a second rail", async () => {
		const container = await renderNavigation("skills");
		expect(
			[
				...nav(container, "data-capability-nav").querySelectorAll(
					'[aria-current="page"]',
				),
			].map((link) => link.textContent),
		).toEqual(["Skills"]);
		expect(container.querySelector("[data-capability-subnav]")).toBeNull();
	});

	it("names no gateway tab", () => {
		expect(
			CAPABILITY_NAV_ITEMS.some((item) =>
				/gateway|connection/i.test(item.label),
			),
		).toBe(false);
	});

	it("renders Kumo link tabs inside named scrollable lists", async () => {
		const container = await renderNavigation("browse");
		const rail = nav(container, "data-capability-nav");
		const group = rail.querySelector(
			'[role="group"][aria-label="Apps, accounts and skills"]',
		);
		expect(group).not.toBeNull();
		const list = group?.querySelector('[role="tablist"]');
		expect(list?.className).toContain("overflow-x-auto");
		expect(list?.className).not.toContain("flex-wrap");
		const tabs = [...(list?.querySelectorAll('a[role="tab"]') ?? [])];
		expect(tabs.map((link) => link.getAttribute("href"))).toEqual(
			CAPABILITY_NAV_ITEMS.map((item) => item.to),
		);
		expect(
			tabs
				.filter((link) => link.getAttribute("aria-selected") === "true")
				.map((link) => link.textContent),
		).toEqual(["Apps"]);
		expect(
			group?.querySelector('[aria-label*="Scroll Apps, accounts and skills"]'),
		).not.toBeNull();
		const subnav = nav(container, "data-capability-subnav");
		expect(
			subnav.querySelector('[role="group"][aria-label="Apps views"]'),
		).not.toBeNull();
		expect(
			[...subnav.querySelectorAll('a[role="tab"]')].map((link) =>
				link.getAttribute("href"),
			),
		).toEqual(["/apps", "/explore/apps?offset=0"]);
	});
});
