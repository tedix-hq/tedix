import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import {
	ADVANCED_WORK_SECTIONS,
	PRIMARY_WORK_SECTIONS,
	WORK_SECTIONS,
	WorkShell,
	workSectionForPathname,
} from "./work-shell";

vi.mock("@tanstack/react-router", () => ({
	Link: ({ to, children, ...rest }: { to: string; children?: ReactNode }) => (
		<a href={to} {...rest}>
			{children}
		</a>
	),
	Outlet: () => null,
	useNavigate: () => () => {},
	useRouterState: ({
		select,
	}: {
		select: (state: { location: { pathname: string } }) => unknown;
	}) => select({ location: { pathname: "/work/admission" } }),
}));

describe("Work shell navigation", () => {
	it("keeps frequent destinations visible and advanced controls in overflow", () => {
		expect(PRIMARY_WORK_SECTIONS.map(([label]) => label)).toEqual([
			"Queue",
			"Portfolio",
			"Attention",
			"Attempts",
			"Approvals",
		]);
		expect(ADVANCED_WORK_SECTIONS.map(([label]) => label)).toEqual([
			"Cases",
			"Graph",
			"Clusters",
			"Admission",
			"Interactions",
			"Capacity",
			"Recovery",
		]);
		expect(
			new Set([...PRIMARY_WORK_SECTIONS, ...ADVANCED_WORK_SECTIONS]),
		).toEqual(new Set(WORK_SECTIONS));
	});

	it("resolves attention routes to the visible primary section", () => {
		expect(workSectionForPathname("/work/control")).toEqual([
			"Attention",
			"/work/control",
		]);
	});

	it("keeps project details in the Portfolio navigation context", () => {
		expect(
			workSectionForPathname(
				"/work/projects/5eed0041-0000-4000-8000-000000000041",
			),
		).toEqual(["Portfolio", "/work/portfolio"]);
	});
});

describe("WorkShell routed tabs", () => {
	it("renders routed desktop tabs as anchors rather than native buttons", () => {
		const doc = new DOMParser().parseFromString(
			renderToStaticMarkup(
				<QueryClientProvider client={new QueryClient()}>
					<WorkShell />
				</QueryClientProvider>,
			),
			"text/html",
		);
		const tabs = [...doc.querySelectorAll('[role="tab"]')];
		expect(tabs.length).toBeGreaterThan(0);
		for (const tab of tabs) {
			expect(tab.tagName).toBe("A");
			expect(tab.getAttribute("type")).toBeNull();
		}
	});

	it("maps nested Work routes to the correct mobile selection", () => {
		expect(workSectionForPathname("/work")).toEqual(["Queue", "/work"]);
		expect(workSectionForPathname("/work/admission")).toEqual([
			"Admission",
			"/work/admission",
		]);
	});

	it("keeps navigation destinations unique", () => {
		expect(new Set(WORK_SECTIONS.map(([, href]) => href)).size).toBe(
			WORK_SECTIONS.length,
		);
	});
});
