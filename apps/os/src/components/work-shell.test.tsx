import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import {
	ALL_WORK_SECTIONS,
	MORE_WORK_SECTIONS,
	WORK_TABS,
	WorkShell,
	workLocation,
} from "./work-shell";

const route = vi.hoisted(() => ({
	pathname: "/work/admission",
	search: {} as Record<string, unknown>,
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
	it("shows Attention first in primary tabs and keeps every other section under More", () => {
		expect(WORK_TABS.map((tab) => tab.label)).toEqual([
			"Attention",
			"Needs you",
			"Board",
			"History",
		]);
		expect(
			WORK_TABS.map((tab) => [tab.label, tab.sections.map((s) => s.label)]),
		).toEqual([
			["Attention", ["Attention"]],
			["Needs you", ["Needs you"]],
			["Board", ["Projects", "Queue"]],
			["History", ["Activity", "Completed"]],
		]);
		expect(MORE_WORK_SECTIONS.map((section) => section.label)).toEqual([
			"Approvals",
			"Requests",
			"Cases",
			"Graph",
			"Clusters",
			"Admission",
			"Capacity",
			"Recovery",
		]);
	});

	it("keeps every former Work destination reachable", () => {
		const reachable = new Set(
			ALL_WORK_SECTIONS.filter((section) => !section.search).map(
				(section) => section.to,
			),
		);
		for (const path of [
			"/work/portfolio",
			"/work/queue",
			"/work/attempts",
			"/work/approvals",
			"/work/interactions",
			"/work/cases",
			"/work/graph",
			"/work/clusters",
			"/work/admission",
			"/work/capacity",
			"/work/recovery",
		])
			expect(reachable.has(path as never)).toBe(true);
	});

	it("keeps section ids unique", () => {
		expect(new Set(ALL_WORK_SECTIONS.map(({ id }) => id)).size).toBe(
			ALL_WORK_SECTIONS.length,
		);
	});

	it("places each Work URL in its tab", () => {
		const at = (pathname: string, search?: { disposition?: string }) => {
			const { tab, section } = workLocation(pathname, search);
			return [tab?.label ?? "More", section.label];
		};
		expect(at("/work/needs-you")).toEqual(["Needs you", "Needs you"]);
		expect(at("/work/portfolio")).toEqual(["Board", "Projects"]);
		expect(at("/work/queue")).toEqual(["Board", "Queue"]);
		expect(at("/work/queue", { disposition: "completed" })).toEqual([
			"History",
			"Completed",
		]);
		expect(at("/work/attempts")).toEqual(["History", "Activity"]);
		expect(at("/work/approvals")).toEqual(["More", "Approvals"]);
		expect(at("/work/interactions/req-1")).toEqual(["More", "Requests"]);
		expect(at("/work/projects/5eed0041-0000-4000-8000-000000000041")).toEqual([
			"Board",
			"Projects",
		]);
		expect(at("/work/items/item-1")).toEqual(["Board", "Projects"]);
	});
});

describe("WorkShell routed tabs", () => {
	it("renders routed desktop tabs as anchors rather than native buttons", () => {
		const doc = renderShell("/work/admission");
		const tabs = [...doc.querySelectorAll('[role="tab"]')];
		expect(tabs.map((tab) => tab.textContent)).toEqual([
			"Attention",
			"Needs you",
			"Board",
			"History",
		]);
		for (const tab of tabs) {
			expect(tab.tagName).toBe("A");
			expect(tab.getAttribute("type")).toBeNull();
		}
		expect(
			doc.querySelector('[aria-label="More Work sections"]')?.textContent,
		).toContain("Admission");
	});

	it("shows the active tab's views with the current one marked", () => {
		const doc = renderShell("/work/queue", { disposition: "completed" });
		const views = doc.querySelector('nav[aria-label="History views"]');
		expect(
			[...(views?.querySelectorAll("a") ?? [])].map((a) => [
				a.textContent,
				a.getAttribute("href"),
				a.getAttribute("aria-current"),
			]),
		).toEqual([
			["Activity", "/work/attempts", null],
			["Completed", "/work/queue?disposition=completed", "page"],
		]);
	});

	it("shows no views row for the single-view Needs you tab", () => {
		const doc = renderShell("/work/needs-you");
		expect(doc.querySelector("nav")).toBeNull();
	});
});
