import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { appDetailQueryOptions } from "@/lib/os-query-options";
import { AppDetailLayout, resolveAppDetailTab } from "./app-detail-layout";

vi.mock("@tanstack/react-router", () => ({
	Link: ({
		to,
		params,
		children,
		...rest
	}: {
		to: string;
		params?: Record<string, string>;
		children?: ReactNode;
	}) => (
		<a href={to.replace("$appId", params?.appId ?? "")} {...rest}>
			{children}
		</a>
	),
	Outlet: () => null,
	useParams: () => ({ appId: "app-123" }),
	useRouterState: ({
		select,
	}: {
		select: (state: { location: { pathname: string } }) => unknown;
	}) => select({ location: { pathname: "/apps/app-123/tools" } }),
}));

function renderLayout(app?: Record<string, unknown>) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	if (app)
		client.setQueryData(appDetailQueryOptions("app-123").queryKey, {
			app,
		} as never);
	return new DOMParser().parseFromString(
		renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<AppDetailLayout />
			</QueryClientProvider>,
		),
		"text/html",
	);
}

describe("app detail routed tabs", () => {
	it("renders routed tabs as anchors rather than native buttons", () => {
		const doc = renderLayout({
			id: "app-123",
			name: "Orders",
			slug: "orders",
			metadata: {},
		});
		const tabs = [...doc.querySelectorAll('[role="tab"]')];
		expect(tabs.map((tab) => tab.textContent)).toEqual([
			"Overview",
			"Analytics",
			"Content",
			"Tools",
			"Evals",
			"Settings",
		]);
		for (const tab of tabs) {
			expect(tab.tagName).toBe("A");
			expect(tab.getAttribute("type")).toBeNull();
		}
		expect(
			tabs.find((tab) => tab.getAttribute("aria-selected") === "true")
				?.textContent,
		).toBe("Tools");
	});

	it("inherits the Kumo skeleton radius for operational loading rows", () => {
		const doc = renderLayout();
		const rows = [...doc.querySelectorAll(".h-14")];
		expect(rows).toHaveLength(3);
		expect(doc.querySelector(".rounded-xl")).toBeNull();
	});

	it("maps every app detail route to the shared tab value", () => {
		const appId = "app-123";

		expect(resolveAppDetailTab(`/apps/${appId}`, appId)).toBe("overview");
		expect(resolveAppDetailTab(`/apps/${appId}/analytics`, appId)).toBe(
			"analytics",
		);
		expect(resolveAppDetailTab(`/apps/${appId}/content`, appId)).toBe(
			"content",
		);
		expect(resolveAppDetailTab(`/apps/${appId}/tools`, appId)).toBe("tools");
		expect(resolveAppDetailTab(`/apps/${appId}/evals`, appId)).toBe("evals");
		expect(resolveAppDetailTab(`/apps/${appId}/settings`, appId)).toBe(
			"settings",
		);
	});

	it("keeps the overview selected for unknown or sibling paths", () => {
		expect(resolveAppDetailTab("/apps/app-123/unknown", "app-123")).toBe(
			"overview",
		);
		expect(resolveAppDetailTab("/apps/other/settings", "app-123")).toBe(
			"overview",
		);
	});
});
