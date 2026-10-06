/**
 * Behavioral coverage for the server-owned tools inventory.
 *
 * Each cache seed represents one exact contract request. That makes these
 * tests fail if the page falls back to client-only filtering/pagination or
 * conflates a filtered result count with the app's complete inventory.
 */

import type { AppTool } from "@tedix/api-contract/schemas/app";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	useParams: () => ({ appId: APP_ID }),
}));

vi.mock("@/lib/app-permissions", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/app-permissions")>()),
	useCanManageApps: () => true,
}));

import {
	APP_TOOLS_PAGE_SIZE,
	appAdaptersListQueryOptions,
	appToolsListQueryOptions,
} from "@/lib/os-query-options";
import { AppToolsPage } from "./app-tools-page";

const APP_ID = "11111111-1111-4111-8111-111111111111";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function makeTool(overrides: Partial<AppTool>): AppTool {
	return {
		id: "row-1",
		toolId: "list_invoices",
		toolTypeId: "mcp",
		title: "List invoices",
		description: "Lists invoices for the org.",
		inputSchema: { type: "object", properties: {} },
		outputSchema: null,
		adapterScope: null,
		resultStrategy: null,
		outputTemplate: null,
		widgetKey: null,
		widgetRoute: null,
		widgetAccessible: null,
		authRequired: false,
		visibility: null,
		icons: null,
		executionTaskSupport: null,
		annotations: null,
		meta: null,
		invocationStatus: null,
		fileParams: null,
		widgetDescription: null,
		widgetPrefersBorder: null,
		widgetDomain: null,
		config: null,
		schemaDialect: null,
		schemaSource: null,
		schemaSourceRef: null,
		schemaSourceHash: null,
		schemaSyncedAt: null,
		sortOrder: null,
		enabled: true,
		createdAt: null,
		updatedAt: null,
		...overrides,
	} as AppTool;
}

function makeTools(count: number, offset = 0): AppTool[] {
	return Array.from({ length: count }, (_, index) =>
		makeTool({
			id: `row-${offset + index + 1}`,
			toolId: `tool_${offset + index + 1}`,
			title: `Tool ${offset + index + 1}`,
			description: `Numbered fixture ${offset + index + 1}.`,
		}),
	);
}

interface ToolsResponse {
	data: AppTool[];
	pagination: {
		limit: number;
		offset: number;
		total: number;
		hasMore: boolean;
	};
	inventoryTotal: number;
}

interface ToolsSeed {
	page?: number;
	query?: string;
	response: ToolsResponse;
}

const cleanups: Array<() => void> = [];

function renderTools(initial: ToolsResponse, additional: ToolsSeed[] = []) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	client.setQueryData(appToolsListQueryOptions(APP_ID).queryKey, initial);
	for (const seed of additional) {
		client.setQueryData(
			appToolsListQueryOptions(APP_ID, {
				page: seed.page,
				query: seed.query,
			}).queryKey,
			seed.response,
		);
	}
	client.setQueryData(appAdaptersListQueryOptions(APP_ID).queryKey, {
		data: [],
		pagination: { limit: 50, offset: 0, total: 0, hasMore: false },
	});

	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	act(() => {
		root.render(
			<QueryClientProvider client={client}>
				<AppToolsPage />
			</QueryClientProvider>,
		);
	});
	cleanups.push(() => {
		act(() => root.unmount());
		container.remove();
	});
	return container;
}

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

function toolsSection(container: HTMLElement): HTMLElement {
	const section = container.querySelector<HTMLElement>(
		'[aria-labelledby="app-tools-title"]',
	);
	if (!section) throw new Error("tools section not rendered");
	return section;
}

function headerCount(container: HTMLElement): string {
	const badge = toolsSection(container).querySelector<HTMLElement>(
		'[data-slot="badge"]',
	);
	if (!badge) throw new Error("tools count badge not rendered");
	return badge.textContent?.trim() ?? "";
}

function rowTitles(container: HTMLElement): string[] {
	return [...toolsSection(container).querySelectorAll("li")].map((row) =>
		(row.querySelector("span")?.textContent ?? "").trim(),
	);
}

function sectionText(container: HTMLElement): string {
	return toolsSection(container).textContent ?? "";
}

function nextPageButton(container: HTMLElement): HTMLElement {
	const button = toolsSection(container).querySelector<HTMLElement>(
		'[aria-label="Next page"]',
	);
	if (!button) throw new Error("next-page control not rendered");
	return button;
}

function click(element: HTMLElement) {
	act(() => element.click());
}

async function typeSearch(container: HTMLElement, value: string) {
	const field = toolsSection(container).querySelector<HTMLInputElement>(
		'[aria-label="Search MCP tools"]',
	);
	if (!field) throw new Error("search field not rendered");
	const setter = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value",
	)?.set;
	if (!setter) throw new Error("value setter missing");
	await act(async () => {
		setter.call(field, value);
		field.dispatchEvent(new Event("input", { bubbles: true }));
		await Promise.resolve();
	});
}

function pageResponse(
	data: AppTool[],
	options: { offset?: number; total: number; inventoryTotal?: number },
): ToolsResponse {
	return {
		data,
		pagination: {
			limit: APP_TOOLS_PAGE_SIZE,
			offset: options.offset ?? 0,
			total: options.total,
			hasMore: (options.offset ?? 0) + APP_TOOLS_PAGE_SIZE < options.total,
		},
		inventoryTotal: options.inventoryTotal ?? options.total,
	};
}

describe("tool count honesty", () => {
	it("shows the exact inventory count while rendering only one bounded page", () => {
		const container = renderTools(
			pageResponse(makeTools(APP_TOOLS_PAGE_SIZE), {
				total: 908,
				inventoryTotal: 908,
			}),
		);

		expect(headerCount(container)).toBe("908");
		expect(rowTitles(container)).toHaveLength(APP_TOOLS_PAGE_SIZE);
		expect(rowTitles(container).at(-1)).toBe("Tool 25");
	});

	it("keeps filtered reach distinct from the complete inventory", async () => {
		const initial = pageResponse(makeTools(APP_TOOLS_PAGE_SIZE), {
			total: 908,
		});
		const match = makeTool({ id: "match", title: "List issues" });
		const container = renderTools(initial, [
			{
				query: "github repository",
				response: pageResponse([match], { total: 1, inventoryTotal: 908 }),
			},
		]);

		await typeSearch(container, "github repository");

		expect(headerCount(container)).toBe("1 of 908");
		expect(rowTitles(container)).toEqual(["List issues"]);
	});
});

describe("server-owned pagination", () => {
	it("advances through independently cached server pages", () => {
		const first = pageResponse(makeTools(25), { total: 60 });
		const container = renderTools(first, [
			{
				page: 2,
				response: pageResponse(makeTools(25, 25), { offset: 25, total: 60 }),
			},
			{
				page: 3,
				response: pageResponse(makeTools(10, 50), { offset: 50, total: 60 }),
			},
		]);

		click(nextPageButton(container));
		expect(rowTitles(container)[0]).toBe("Tool 26");
		expect(rowTitles(container).at(-1)).toBe("Tool 50");

		click(nextPageButton(container));
		expect(rowTitles(container)).toHaveLength(10);
		expect(rowTitles(container)[0]).toBe("Tool 51");
	});

	it("does not render pagination when the complete result fits", () => {
		const container = renderTools(pageResponse(makeTools(3), { total: 3 }));
		expect(
			toolsSection(container).querySelector('[aria-label="Next page"]'),
		).toBeNull();
	});

	it("returns a search from a later page to the first server page", async () => {
		const initial = pageResponse(makeTools(25), { total: 60 });
		const container = renderTools(initial, [
			{
				page: 2,
				response: pageResponse(makeTools(25, 25), { offset: 25, total: 60 }),
			},
			{
				query: "tool 1",
				response: pageResponse([makeTools(1)[0]!], {
					total: 1,
					inventoryTotal: 60,
				}),
			},
		]);
		click(nextPageButton(container));
		expect(rowTitles(container)[0]).toBe("Tool 26");

		await typeSearch(container, "tool 1");

		expect(rowTitles(container)).toEqual(["Tool 1"]);
		expect(headerCount(container)).toBe("1 of 60");
	});
});

describe("empty states", () => {
	it("claims the app has no tools only from an exact zero inventory", () => {
		const container = renderTools(pageResponse([], { total: 0 }));
		expect(sectionText(container)).toContain("No MCP tools configured");
	});

	it("scopes a fruitless server search to the complete inventory", async () => {
		const initial = pageResponse(makeTools(3), { total: 3 });
		const container = renderTools(initial, [
			{
				query: "no-such-tool",
				response: pageResponse([], { total: 0, inventoryTotal: 3 }),
			},
		]);

		await typeSearch(container, "no-such-tool");

		const text = sectionText(container);
		expect(text).toContain("No matching tools");
		expect(text).toContain("3-tool inventory");
		expect(text).not.toContain("No MCP tools configured");
	});
});
