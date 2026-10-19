import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { WorkShell } from "./work-shell";

const route = vi.hoisted(() => ({
	pathname: "/work/admission",
	search: {} as Record<string, unknown>,
	defaultView: "deck" as "deck" | "feed",
	withCount: false,
	count: { count: 0, pending: false, failed: false },
}));

vi.mock("@/lib/use-work-apps", () => ({
	useWorkApps: () => ({
		apps: ["deck", "feed"].map((role) => ({
			role,
			gadget: { workspaceId: "cedar-workspace" },
			manifest: {
				navigation: { workDefault: role === route.defaultView },
				...(route.withCount && role === "deck"
					? { config: { version: 1 } }
					: {}),
			},
		})),
	}),
}));

vi.mock("@/lib/use-deck-count", () => ({
	useDeckCount: () => route.count,
}));

vi.mock("@tanstack/react-router", () => ({
	Link: ({
		to,
		search,
		children,
		preload: _preload,
		...rest
	}: {
		to: string;
		search?: Record<string, string>;
		preload?: string;
		children?: ReactNode;
	}) => (
		<a href={search ? `${to}?${new URLSearchParams(search)}` : to} {...rest}>
			{children}
		</a>
	),
	Outlet: () => null,
	useNavigate: () => () => {},
	useRouterState: ({
		select,
	}: {
		select: (state: {
			location: { pathname: string; search: Record<string, unknown> };
		}) => unknown;
	}) =>
		select({ location: { pathname: route.pathname, search: route.search } }),
}));

function renderShell(pathname: string, search: Record<string, unknown> = {}) {
	route.pathname = pathname;
	route.search = search;
	return new DOMParser().parseFromString(
		renderToStaticMarkup(
			<QueryClientProvider client={new QueryClient()}>
				<WorkShell />
			</QueryClientProvider>,
		),
		"text/html",
	);
}

describe("Work shell navigation", () => {
	it("marks the configured default and respects an explicit view", () => {
		expect(
			renderShell("/work").querySelector('[aria-current="page"]')?.textContent,
		).toBe("Deck");
		route.defaultView = "feed";
		expect(
			renderShell("/work").querySelector('[aria-current="page"]')?.textContent,
		).toBe("Feed");
		route.defaultView = "deck";
		expect(
			renderShell("/work", { view: "feed" }).querySelector(
				'[aria-current="page"]',
			)?.textContent,
		).toBe("Feed");
	});
	it("offers only Feed and Deck on the phone and removes tabs, More and the section picker", () => {
		const doc = renderShell("/work");
		expect(
			[...doc.querySelectorAll("nav a")].map((a) => [
				a.textContent,
				a.getAttribute("href"),
			]),
		).toEqual([
			["Feed", "/work?view=feed"],
			["Deck", "/work?view=deck"],
		]);
		expect(doc.querySelector('[role="tablist"]')).toBeNull();
		expect(doc.querySelector('[aria-label="More Work sections"]')).toBeNull();
		expect(doc.querySelector('[aria-label="Work section"]')).toBeNull();
		expect(doc.querySelector("nav")?.className).toContain("bottom-0");
	});
	it("marks Deck when it is selected and keeps navigation on record pages", () => {
		const doc = renderShell("/work", { view: "deck" });
		expect(doc.querySelector('[aria-current="page"]')?.textContent).toBe(
			"Deck",
		);
		expect(
			renderShell("/work/items/cedar-review").querySelectorAll("nav a"),
		).toHaveLength(2);
	});
});

it("lets the configured Work app own the landing without the legacy tab bar", () => {
	const doc = renderShell("/work");
	expect(doc.querySelector('[role="tablist"]')).toBeNull();
	expect(doc.querySelector('[aria-label="More Work sections"]')).toBeNull();
});

it("shows known Deck counts including zero and leaves unknown counts empty", () => {
	route.withCount = true;
	try {
		for (const count of [0, 12]) {
			route.count = { count, pending: false, failed: false };
			expect(
				renderShell("/work").querySelector('a[href="/work?view=deck"] span')
					?.textContent,
			).toBe(String(count));
		}
		for (const state of [
			{ pending: true, failed: false },
			{ pending: false, failed: true },
		]) {
			route.count = { count: 12, ...state };
			expect(
				renderShell("/work").querySelector('a[href="/work?view=deck"]')
					?.textContent,
			).toBe("Deck");
		}
	} finally {
		route.withCount = false;
		route.count = { count: 0, pending: false, failed: false };
	}
});
