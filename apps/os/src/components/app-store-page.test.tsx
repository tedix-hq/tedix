import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRouteWithContext,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";

const catalog = vi.hoisted(() => ({
	list: vi.fn(),
	getCategories: vi.fn(),
	getStats: vi.fn(),
	getHealthSummary: vi.fn(),
	installFromCatalog: vi.fn(async () => ({ ok: true })),
	getBySlug: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ osApi: { catalog, apps: {} } }));
import { AppStorePage } from "./app-store-page";
import * as localInference from "@/lib/local-inference";
import { AppStoreDetailPage, InstallButton } from "./app-store-detail-page";
import { Page } from "@/components/kumo/page";
import {
	catalogAppDetailQueryOptions,
	osQueryKeys,
} from "@/lib/os-query-options";
import { Route as StoreRoute } from "@/routes/_session/_tenant/explore.apps";

import { catalogCategoryLabel, catalogListInput } from "@/lib/catalog-search";

describe("App Store migration", () => {
	it("shows local unavailability without fetching the fleet catalog", () => {
		const local = vi
			.spyOn(localInference, "isLocalSession")
			.mockReturnValue(true);
		try {
			const html = renderToStaticMarkup(
				<AppStorePage search={{ offset: 0 }} updateSearch={() => {}} />,
			);
			expect(html).toContain("App browsing is off locally");
		} finally {
			local.mockRestore();
		}
	});
	it("projects every shareable URL filter into the catalog query input", () => {
		expect(
			catalogListInput({
				search: "mail",
				category: "PRODUCTIVITY",
				connectorType: "MCP",
				sortBy: "name",
				healthStatus: "healthy",
				offset: 30,
			}),
		).toEqual({
			limit: 30,
			offset: 30,
			search: "mail",
			category: "PRODUCTIVITY",
			connectorType: "MCP",
			sortBy: "name",
			healthStatus: "healthy",
		});
	});

	it("keeps known category labels readable and unknown ones lossless", () => {
		expect(catalogCategoryLabel("DEVELOPER_TOOLS")).toBe("Developer Tools");
		expect(catalogCategoryLabel("CUSTOM_VERTICAL")).toBe("CUSTOM_VERTICAL");
	});

	it("uses the shared Kumo hierarchy and preserves responsive shrink boundaries", async () => {
		const { host } = await mountStore("/explore/apps?offset=0", () => {
			catalog.list.mockResolvedValue({
				...emptyCatalog,
				total: 1,
				apps: [
					{
						id: "acme",
						slug: "acme",
						name: "Acme with a very long catalog name",
						description: "Accounts and invoices",
						developer: "Acme Labs",
						installability: { installable: true },
					},
				],
			});
		});
		expect(host.querySelector('[data-slot="page"]')?.className).toBe(
			kumoClass(<Page width="xl" />),
		);
		expect(host.textContent).toContain("Browse apps");
		// The overview section lives behind the diagnostics disclosure.
		const diagnostics = [...host.querySelectorAll<HTMLElement>("button")].find(
			(button) => button.textContent?.trim() === "Catalog diagnostics",
		)!;
		await act(async () => diagnostics.click());
		await flush();
		expect(host.textContent).toContain("Catalog overview");
		expect(
			host.querySelector(
				".sm\\:grid-cols-\\[minmax\\(0\\,1fr\\)_12rem_auto\\]",
			),
		).not.toBeNull();
		const title = [...host.querySelectorAll('[data-slot="card-title"]')].find(
			(element) => element.textContent?.includes("Acme"),
		);
		expect(title?.classList.contains("min-w-0")).toBe(true);
		expect(title?.classList.contains("truncate")).toBe(true);
		const card = title?.closest('[data-slot="card"]');
		expect(card?.getAttribute("data-size")).toBe("sm");
		const byline = card?.querySelector('[data-slot="card-description"]');
		expect(byline?.textContent).toBe("by Acme Labs");
		expect(byline?.classList.contains("truncate")).toBe(true);
		for (const header of host.querySelectorAll('[data-slot="card-header"]'))
			expect(header.classList.contains("pb-3")).toBe(false);
		for (const content of host.querySelectorAll('[data-slot="card-content"]'))
			expect(content.classList.contains("pt-0")).toBe(false);
		expect(host.querySelector(".text-\\[10px\\]")).toBeNull();
	});

	it("lays out the app detail with shrinkable columns and wraps long names", async () => {
		const { host } = await mountInRouter(
			<AppStoreDetailPage slug="acme" />,
			(client) =>
				client.setQueryData(catalogAppDetailQueryOptions("acme").queryKey, {
					id: "acme",
					slug: "acme",
					name: "Acme",
					tools: [
						{
							id: "tool-1",
							toolName: "list_invoices",
							description: "Lists invoices.",
							inputSchema: { type: "object", properties: {} },
							annotations: { readOnlyHint: true },
							detectedAt: "2026-08-23T00:00:00.000Z",
							lastSeenAt: "2026-08-23T00:00:00.000Z",
							removedAt: null,
							lastTestedAt: null,
							testSuccessRate: null,
							avgLatencyMs: null,
							testCount: 0,
							exampleInput: null,
							exampleOutput: null,
						},
					],
					installability: { installable: true },
				} as never),
		);
		expect(host.querySelector('[data-slot="page"]')?.className).toBe(
			kumoClass(<Page width="xl" />),
		);
		expect(host.textContent).toContain("Capabilities");
		const grid = host.querySelector(".lg\\:grid-cols-3");
		expect(grid?.classList.contains("min-w-0")).toBe(true);
		expect(
			grid?.querySelector(".lg\\:col-span-2")?.classList.contains("min-w-0"),
		).toBe(true);
		expect(
			host.querySelector('[aria-label="App metadata"]')?.closest(".min-w-0"),
		).not.toBeNull();
		expect(host.querySelector("h1")?.className).toContain(
			"[overflow-wrap:anywhere]",
		);
		expect(
			host.querySelector('[data-slot="page-actions"]')?.textContent,
		).toContain("Review installation");
	});

	it("lists same-vendor variants under Also available as", async () => {
		const { host } = await mountInRouter(
			<AppStoreDetailPage slug="acme-listing" />,
			(client) =>
				client.setQueryData(
					catalogAppDetailQueryOptions("acme-listing").queryKey,
					{
						id: "acme-listing",
						slug: "acme-listing",
						name: "Acme",
						tools: [],
						installability: { installable: false, reason: "Listing" },
						variants: [
							{
								id: "acme-mcp",
								slug: "acme",
								name: "Acme",
								source: "official",
								installabilityState: "installable",
								mcpToolCount: 4,
							},
							{
								id: "acme-claude",
								slug: "acme-claude",
								name: "Acme",
								source: "claude",
								installabilityState: "listing_only",
								mcpToolCount: 0,
							},
						],
					} as never,
				),
		);
		const section = host.querySelector(
			'[aria-labelledby="app-variants-heading"]',
		);
		expect(section?.textContent).toContain("Also available as");
		expect(section?.textContent).toContain("4 tools");
		expect(section?.textContent).toContain("Listing only");
		expect(
			[...(section?.querySelectorAll("a") ?? [])].map((a) =>
				a.getAttribute("href"),
			),
		).toEqual(["/explore/apps/acme", "/explore/apps/acme-claude"]);
	});

	it("installs after review and refreshes the apps and catalog domains", async () => {
		const { host, invalidated } = await mountInRouter(
			<InstallButton appId="acme" name="Acme" disabled={false} reason="" />,
		);
		const review = [...host.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("Review installation"),
		)!;
		await act(async () => review.click());
		expect(catalog.installFromCatalog).not.toHaveBeenCalled();
		const install = [...document.body.querySelectorAll("button")].find(
			(button) => button.textContent?.trim() === "Install for organization",
		)!;
		await act(async () => install.click());
		await flush();
		expect(catalog.installFromCatalog).toHaveBeenCalledWith({
			catalogAppId: "acme",
			visibility: "private",
		});
		expect(invalidated).toEqual(
			expect.arrayContaining([osQueryKeys.apps(), osQueryKeys.catalog()]),
		);
	});
});

async function mountInRouter(
	element: React.ReactElement,
	seed?: (client: QueryClient) => void,
) {
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	seed?.(queryClient);
	const invalidated: unknown[] = [];
	const invalidate = queryClient.invalidateQueries.bind(queryClient);
	queryClient.invalidateQueries = (async (
		filters?: Parameters<typeof invalidate>[0],
	) => {
		invalidated.push(filters?.queryKey);
		return invalidate(filters);
	}) as typeof queryClient.invalidateQueries;
	const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
		component: () => element,
	});
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
		context: { queryClient },
	});
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	cleanups.push(() => {
		act(() => root.unmount());
		queryClient.clear();
		host.remove();
	});
	await act(async () => {
		root.render(
			<QueryClientProvider client={queryClient}>
				<RouterProvider router={router} />
			</QueryClientProvider>,
		);
		await router.load();
	});
	await flush();
	return { host, invalidated };
}

const kumoClass = (element: React.ReactElement) =>
	new DOMParser().parseFromString(renderToStaticMarkup(element), "text/html")
		.body.firstElementChild?.className;

const emptyCatalog = {
	apps: [],
	total: 0,
	pagination: { limit: 30, offset: 0, hasMore: false },
};
const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.clearAllMocks();
});

async function flush(ms = 0) {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, ms));
	});
}

async function mountStore(
	url = "/explore/apps?offset=0",
	configureCatalog?: () => void,
) {
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
	catalog.list.mockReset().mockResolvedValue(emptyCatalog);
	catalog.getCategories.mockReset().mockResolvedValue([]);
	catalog.getStats.mockReset().mockResolvedValue({
		total: 0,
		mcp: 0,
		withInteractive: 0,
		withWrites: 0,
	});
	catalog.getHealthSummary.mockReset().mockResolvedValue({
		scanBacklog: null,
	});
	configureCatalog?.();
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
		component: Outlet,
	});
	const route = createRoute({
		getParentRoute: () => rootRoute,
		path: "/explore/apps",
		validateSearch: StoreRoute.options.validateSearch,
		loaderDeps: ({ search }) => search,
		loader: (context) => {
			const loader = StoreRoute.options.loader;
			if (typeof loader !== "function") throw new Error("Store loader missing");
			return loader(context as unknown as Parameters<typeof loader>[0]);
		},
		component: function StoreHarness() {
			const search = route.useSearch();
			const navigate = route.useNavigate();
			return (
				<AppStorePage
					search={search}
					updateSearch={(patch) =>
						void navigate({
							search: (previous) => ({ ...previous, ...patch }),
							replace: "search" in patch,
							resetScroll: false,
						})
					}
				/>
			);
		},
		pendingComponent: () => <p>Route pending</p>,
		pendingMs: 10,
		pendingMinMs: 0,
	});
	const other = createRoute({
		getParentRoute: () => rootRoute,
		path: "/other",
		component: () => <p>Other page</p>,
	});
	const history = createMemoryHistory({ initialEntries: [url] });
	const router = createRouter({
		routeTree: rootRoute.addChildren([route, other]),
		history,
		context: { queryClient },
	});
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	cleanups.push(() => {
		act(() => root.unmount());
		queryClient.clear();
		host.remove();
	});
	await act(async () => {
		root.render(
			<QueryClientProvider client={queryClient}>
				<RouterProvider router={router} />
			</QueryClientProvider>,
		);
		await router.load();
	});
	await flush();
	const input = host.querySelector<HTMLInputElement>('input[type="search"]');
	if (!input) throw new Error("Search input missing");
	return { host, input, router, history };
}

describe("App Store auxiliary fallbacks", () => {
	it("renders the critical app list when category summaries fail", async () => {
		const { host } = await mountStore("/explore/apps?offset=0", () => {
			catalog.list.mockResolvedValue({
				...emptyCatalog,
				total: 1,
				apps: [
					{
						id: "acme",
						slug: "acme",
						name: "Acme",
						installability: { installable: true },
					},
				],
			});
			catalog.getCategories.mockRejectedValue(
				new Error("category summary unavailable"),
			);
		});

		expect(host.textContent).toContain("Acme");
		expect(host.textContent).toContain(
			"Category filters are unavailable. Search and browsing still work.",
		);
		expect(host.textContent).not.toContain("Route pending");
	});

	it.each(["getStats", "getHealthSummary"] as const)(
		"keeps browsing usable when %s fails",
		async (method) => {
			const { host } = await mountStore("/explore/apps?offset=0", () => {
				catalog.list.mockResolvedValue({
					...emptyCatalog,
					total: 1,
					apps: [
						{
							id: "acme",
							slug: "acme",
							name: "Acme",
							installability: { installable: true },
						},
					],
				});
				catalog[method].mockRejectedValue(new Error(`${method} unavailable`));
			});
			const diagnostics = Array.from(host.querySelectorAll("button")).find(
				(button) => button.textContent === "Catalog diagnostics",
			)!;
			await act(async () => diagnostics.click());
			await flush();

			expect(host.textContent).toContain("Acme");
			expect(host.textContent).toContain(
				"Catalog diagnostics are unavailable. You can still browse apps.",
			);
		},
	);
});

function typeValue(input: HTMLInputElement, value: string) {
	const set = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value",
	)!.set!;
	act(() => {
		set.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

describe("App Store search interaction", () => {
	it("keeps complete text and focus while a filter request is pending, then displays the matching results", async () => {
		const { host, input, router } = await mountStore(
			"/explore/apps?offset=30&category=PRODUCTIVITY&search=f",
		);
		let resolveSearch!: (value: unknown) => void;
		catalog.list.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveSearch = resolve;
				}),
		);
		input.focus();
		for (const character of "igma") {
			const next = input.value + character;
			typeValue(input, next);
			expect(input.value).toBe(next);
			expect(document.activeElement).toBe(input);
		}
		expect(input.value).toBe("figma");
		await flush(300);
		expect(router.state.location.search).toMatchObject({
			search: "figma",
			offset: 0,
			category: "PRODUCTIVITY",
		});
		expect(catalog.list).toHaveBeenLastCalledWith(
			expect.objectContaining({
				search: "figma",
				offset: 0,
				category: "PRODUCTIVITY",
			}),
			expect.anything(),
		);
		await flush(50);
		expect(host.querySelector('input[type="search"]')).toBe(input);
		expect(document.activeElement).toBe(input);
		expect(host.textContent).toContain("Searching apps");
		expect(host.textContent).not.toContain("Route pending");
		await act(async () =>
			resolveSearch({
				...emptyCatalog,
				total: 1,
				apps: [
					{
						id: "figma",
						slug: "figma",
						name: "Figma",
						installability: { installable: true },
					},
				],
			}),
		);
		await flush();
		expect(host.textContent).toContain("Figma");
		expect(input.value).toBe("figma");
		expect(document.activeElement).toBe(input);
	});

	it("cancels a pending draft when clearing filters", async () => {
		const { host, input, router } = await mountStore(
			"/explore/apps?offset=30&category=PRODUCTIVITY",
		);
		typeValue(input, "figma");
		const clear = Array.from(host.querySelectorAll("button")).find(
			(button) => button.textContent === "Clear filters",
		)!;
		await act(async () => clear.click());
		await flush(350);
		expect(input.value).toBe("");
		expect(router.state.location.search).toMatchObject({ offset: 0 });
		expect(router.state.location.search.search).toBeUndefined();
		expect(
			catalog.list.mock.calls.some(([query]) => query.search === "figma"),
		).toBe(false);
	});

	it("restores the field on Back and Forward without replaying a cancelled draft", async () => {
		const { input, router, history } = await mountStore(
			"/explore/apps?offset=0&search=alpha",
		);
		await act(async () => {
			await router.navigate({
				to: "/explore/apps",
				search: { search: "beta", offset: 0 },
			});
		});
		await flush();
		expect(input.value).toBe("beta");
		typeValue(input, "unfinished");
		await act(async () => history.back());
		await flush(350);
		expect(input.value).toBe("alpha");
		expect(router.state.location.search.search).toBe("alpha");
		await act(async () => history.forward());
		await flush();
		expect(input.value).toBe("beta");
	});

	it("waits for IME composition and lets Enter submit immediately", async () => {
		const { input, router } = await mountStore();
		act(() =>
			input.dispatchEvent(
				new CompositionEvent("compositionstart", { bubbles: true }),
			),
		);
		typeValue(input, "日本");
		await flush(300);
		expect(router.state.location.search.search).toBeUndefined();
		act(() =>
			input.dispatchEvent(
				new CompositionEvent("compositionend", { bubbles: true }),
			),
		);
		await act(async () =>
			input.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
			),
		);
		await flush();
		expect(router.state.location.search.search).toBe("日本");
	});

	it("discards the search timer when leaving the store", async () => {
		const { input, router } = await mountStore();
		typeValue(input, "figma");
		await act(async () => {
			router.history.push("/other");
			await router.load();
		});
		await flush(350);
		expect(router.state.location.pathname).toBe("/other");
		expect(
			catalog.list.mock.calls.some(([query]) => query.search === "figma"),
		).toBe(false);
	});
});
