import type {
	EligibilityBadge,
	EligibilityResult,
} from "@tedix/api-contract/schemas/app-gating";
import type { AppListItem } from "@tedix/api-contract/schemas/app";
import type { UserConnection } from "@tedix/api-contract/schemas/connections";
import type { ConnectionInventoryRow } from "@tedix/api-contract/schemas/connections";
import { renderToStaticMarkup } from "react-dom/server";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const mcpHealth = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("@/lib/api", () => {
	const client = (path: string[]): unknown =>
		new Proxy(() => Promise.resolve({ data: [] }), {
			get: (_target, name) =>
				typeof name === "string" ? client([...path, name]) : undefined,
		});
	return { osApi: client([]), osDirectReadApi: { mcpHealth } };
});
vi.mock("@/lib/connections-actions", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/connections-actions")>()),
	useCanManageConnections: () => true,
	useCanManagePersonalOauthConnections: () => true,
	useConnectionCompleteListener: () => {},
	useDisconnectConnection: () => ({
		isPending: false,
		isError: false,
		mutate: () => {},
	}),
}));
import { Collection } from "@/components/kumo/page";
import {
	appGatewayMembershipsQueryOptions,
	appListQueryOptions,
	connectionsOverviewQueryOptions,
	installedAppEligibilityQueryOptions,
	userConnectionsQueryOptions,
} from "@/lib/os-query-options";
import {
	AppChip,
	appConnectionStatus,
	appGatewayStatus,
	appMcpHost,
	AppRowMain,
	appServiceStatus,
	AppsEmpty,
	AppsPage,
	badgeTone,
	ConnectionRow,
	ConnectionsEmpty,
	ConnectionsPanel,
	connectionFailureMessage,
	connectionTone,
	completedServiceCheck,
	filterInstalledApps,
	grantedScopesLabel,
	toolCountLabel,
	visibilityLabel,
	visibilityTone,
} from "./apps-page";

const baseApp: AppListItem = {
	id: "11111111-1111-4111-8111-111111111111",
	name: "Acme",
	slug: "acme",
	domain: "acme.example",
	description: "Auto repair shop operations",
	logoUrl: null,
	visibility: "public",
	discoveryStatus: "scraped",
	customMcpDomain: null,
	appStoreStatus: "approved",
	createdAt: "2026-08-01T10:00:00.000Z",
	updatedAt: "2026-08-12T10:00:00.000Z",
};

const readyResult: EligibilityResult = {
	eligible: true,
	degraded: false,
	missing: [],
	availableTools: ["list_orders", "get_order", "record_note"],
	unavailableTools: [],
};

const gatedResult: EligibilityResult = {
	eligible: false,
	degraded: true,
	missing: [
		{
			type: "connector",
			key: "gmail",
			detail: "Gmail connection required",
		},
	],
	availableTools: ["list_orders"],
	unavailableTools: [
		{
			name: "send_email",
			reason: "missing connector gmail",
			missing: [{ type: "connector", key: "gmail" }],
		},
	],
};

const baseConnection: UserConnection = {
	appId: "gmail",
	providerName: "Gmail",
	status: "connected",
	connectedAt: 1_754_900_000,
	tokenExpiresAt: null,
	scopes: ["gmail.readonly", "gmail.send"],
	tokenScope: "tenant",
	connectedByUserId: "user-1",
	connectedByEmail: "owner@acme.example",
};

const connectedInventory: ConnectionInventoryRow = {
	provider: {
		appId: "initech-api-key",
		name: "Initech",
		description: null,
		connectionType: "api_key",
		registrationMode: null,
		enabled: true,
		availableScopes: [],
		logoUrl: null,
		tokenScope: "tenant",
		supportedScopes: ["tenant"],
		recommendedScope: "tenant",
		referencedByOrg: true,
	},
	scope: "tenant",
	accountState: "present",
	accountLabel: "Initech",
	connection: baseConnection,
	references: [{ appId: baseApp.id, appSlug: baseApp.slug, source: "app" }],
	referencesComplete: true,
	access: "not_evaluated",
	health: "not_checked",
};

describe("visibility helpers", () => {
	it("maps visibility to chip tones with disabled as the off state", () => {
		expect(visibilityTone("public")).toBe("done");
		expect(visibilityTone("private")).toBe("active");
		expect(visibilityTone("disabled")).toBe("blocked");
		expect(visibilityTone(null)).toBe("neutral");
	});

	it("labels null visibility honestly", () => {
		expect(visibilityLabel("public")).toBe("public");
		expect(visibilityLabel(null)).toBe("unknown");
	});
});

describe("badgeTone", () => {
	it("marks ready as done and gated badges as warnings", () => {
		expect(badgeTone("ready")).toBe("done");
		expect(badgeTone("setup_needed")).toBe("warn");
		expect(badgeTone("plan_upgrade")).toBe("warn");
	});
});

describe("appMcpHost", () => {
	it("builds the conventional MCP hostname from the slug", () => {
		expect(appMcpHost(baseApp)).toBe("acme.mcp.tedix.dev");
	});

	it("honors the customMcpDomain override", () => {
		expect(
			appMcpHost({ ...baseApp, customMcpDomain: "mcp.acme.example" }),
		).toBe("mcp.acme.example");
	});
});

describe("filterInstalledApps", () => {
	const cloudflareApp: AppListItem = {
		...baseApp,
		id: "22222222-2222-4222-8222-222222222222",
		name: "Cloudflare",
		slug: "cloudflare",
		domain: "cloudflare.com",
		description: "Workers, D1, R2, and DNS",
	};

	it("matches every normalized term across app identity fields", () => {
		expect(
			filterInstalledApps([baseApp, cloudflareApp], "workers dns"),
		).toEqual([cloudflareApp]);
		expect(
			filterInstalledApps([baseApp, cloudflareApp], "MCP.TEDIX.DEV"),
		).toHaveLength(2);
		expect(
			filterInstalledApps([baseApp, cloudflareApp], "acme.example"),
		).toEqual([baseApp]);
	});

	it("returns the complete loaded collection for a blank query", () => {
		expect(filterInstalledApps([baseApp, cloudflareApp], "   ")).toEqual([
			baseApp,
			cloudflareApp,
		]);
	});
});

describe("toolCountLabel", () => {
	it("counts available and gated tools together", () => {
		expect(toolCountLabel(readyResult)).toBe("3 tools");
		expect(toolCountLabel(gatedResult)).toBe("2 tools · 1 gated");
	});

	it("singularizes and preserves an unknown empty inventory", () => {
		expect(
			toolCountLabel({ ...readyResult, availableTools: ["one_tool"] }),
		).toBe("1 tool");
		expect(toolCountLabel({ ...readyResult, availableTools: [] })).toBe(
			"tool count unavailable",
		);
	});
});

describe("AppChip", () => {
	it("renders a Kumo Badge stamped with its governance tone", () => {
		const html = renderToStaticMarkup(<AppChip tone="done">x</AppChip>);
		expect(html).toContain('data-slot="badge"');
		expect(html).toContain('data-tone="done"');
	});

	it("stamps the warn tone for warning chips", () => {
		expect(renderToStaticMarkup(<AppChip tone="warn">x</AppChip>)).toContain(
			'data-tone="warn"',
		);
	});
});

describe("AppRowMain", () => {
	it("maps a completed protocol probe without upgrading provider health", () => {
		expect(
			completedServiceCheck({
				allPassed: true,
				passCount: 7,
				failCount: 0,
				toolCount: 223,
			}),
		).toMatchObject({
			status: "passed",
			toolCount: 223,
			detail: "7 protocol checks passed.",
		});
		expect(
			completedServiceCheck({
				allPassed: false,
				passCount: 5,
				failCount: 2,
				toolCount: null,
			}),
		).toMatchObject({
			status: "failed",
			toolCount: null,
			detail: "2 of 7 protocol checks failed.",
		});
	});

	it("renders name, slug, MCP host, and the visibility chip", () => {
		const html = renderToStaticMarkup(<AppRowMain app={baseApp} />);
		expect(html).toContain("Acme");
		expect(html).toContain("acme · acme.mcp.tedix.dev");
		expect(html).toContain('data-tone="done"');
		expect(html).toContain("Public");
		expect(html).toContain("Auto repair shop operations");
		expect(html.indexOf("Acme")).toBeLessThan(html.indexOf("Public"));
	});

	it("keeps the identity block narrow enough for table and mobile rows", () => {
		const html = renderToStaticMarkup(<AppRowMain app={baseApp} />);
		expect(html).toContain('class="grid min-w-0 gap-1"');
	});

	it("renders the governance badge and tool count when eligibility is known", () => {
		const html = renderToStaticMarkup(
			<AppRowMain
				app={baseApp}
				eligibility={{
					badge: "setup_needed" as EligibilityBadge,
					result: gatedResult,
				}}
			/>,
		);
		expect(html).toContain("Setup needed");
		expect(html).toContain('data-tone="warn"');
		expect(html).toContain("2 tools · 1 gated");
	});

	it("keeps governance and inventory distinct from service checks", () => {
		const html = renderToStaticMarkup(
			<AppRowMain
				app={baseApp}
				eligibility={{ badge: "ready", result: readyResult }}
			/>,
		);
		expect(html).toContain("Governance ready");
		expect(html).toContain("3 tools in governance inventory");
		expect(html).toContain("acme · acme.mcp.tedix.dev");
		expect(html.match(/data-slot="badge"/g)).toHaveLength(2);
		expect(html).not.toContain(">Healthy<");
	});

	it("omits badge and description when absent", () => {
		const html = renderToStaticMarkup(
			<AppRowMain app={{ ...baseApp, description: null }} />,
		);
		expect(html).not.toContain("Setup needed");
		expect(html).not.toContain("Auto repair shop operations");
	});
});

describe("installed app statuses", () => {
	it("separates a connected credential from missing, unknown, and unloaded inventory", () => {
		expect(appConnectionStatus([connectedInventory], true)).toEqual({
			label: "Connected",
			tone: "done",
		});
		expect(
			appConnectionStatus(
				[{ ...connectedInventory, accountState: "missing", connection: null }],
				true,
			),
		).toEqual({ label: "Needs setup", tone: "warn" });
		expect(appConnectionStatus([], true)).toEqual({
			label: "Not listed",
			tone: "neutral",
		});
		expect(
			appConnectionStatus(
				[
					connectedInventory,
					{ ...connectedInventory, accountState: "missing", connection: null },
				],
				true,
			),
		).toEqual({ label: "Needs setup", tone: "warn" });
		expect(appConnectionStatus([], false)).toEqual({
			label: "Unavailable",
			tone: "neutral",
		});
	});

	it("does not turn a passing MCP protocol check into provider health", () => {
		expect(appGatewayStatus("enabled")).toEqual({
			label: "Included",
			tone: "done",
		});
		expect(appServiceStatus()).toEqual({
			label: "Not checked",
			tone: "neutral",
		});
		expect(
			appServiceStatus({
				status: "passed",
				toolCount: 4,
				detail: "3 protocol checks passed.",
			}),
		).toEqual({ label: "Passed", tone: "done" });
	});
});

describe("ConnectionRow", () => {
	it("renders provider, status, granted scope count, and credential scope", () => {
		const html = renderToStaticMarkup(
			<ConnectionRow connection={baseConnection} />,
		);
		expect(html).toContain("Gmail");
		expect(html).toContain("Connected");
		expect(html).toContain("2 granted scopes");
		expect(html).toContain("org-shared credential");
		expect(html).toContain("connected by owner@acme.example");
	});

	it("marks expired and revoked connections with honest tones", () => {
		expect(connectionTone("connected")).toBe("done");
		expect(connectionTone("expired")).toBe("warn");
		expect(connectionTone("revoked")).toBe("blocked");
		const html = renderToStaticMarkup(
			<ConnectionRow
				connection={{
					...baseConnection,
					status: "revoked",
					tokenScope: "user",
					scopes: ["gmail.readonly"],
					connectedByEmail: null,
				}}
			/>,
		);
		expect(html).toContain("Revoked");
		expect(html).toContain("1 granted scope");
		expect(html).toContain("personal credential");
		expect(html).not.toContain("connected by");
	});

	it("counts granted scopes, not available ones", () => {
		expect(grantedScopesLabel(baseConnection)).toBe("2 granted scopes");
		expect(grantedScopesLabel({ ...baseConnection, scopes: [] })).toBe(
			"0 granted scopes",
		);
	});
});

describe("empty states", () => {
	it("explains the empty app list without implying failure", () => {
		const html = renderToStaticMarkup(<AppsEmpty />);
		expect(html).toContain("No apps yet");
		expect(html).toContain("App Store");
		expect(html).not.toContain("Dashboard");
	});

	it("explains that ungranted connections gate apps", () => {
		expect(renderToStaticMarkup(<ConnectionsEmpty />)).toContain(
			"No connections granted yet",
		);
	});

	it("distinguishes intentional local isolation from a production outage", () => {
		expect(connectionFailureMessage(true)).toContain("intentionally absent");
		expect(connectionFailureMessage(false)).toContain("unavailable right now");
	});
});

describe("Installed Apps layout", () => {
	const manyApps = (count: number): AppListItem[] =>
		Array.from({ length: count }, (_, index) => ({
			...baseApp,
			id: `app-${index + 1}`,
			name: `Fleet app ${index + 1}`,
			slug: `fleet-${index + 1}`,
		}));

	it("bounds the loaded inventory and resets continuation when search changes", async () => {
		const page = await mountAppsPage({ apps: manyApps(20) });
		expect(page.rows()).toHaveLength(15);
		expect(page.host.textContent).toContain("Showing 15 of 20 installed apps");
		await act(async () => page.button("Show more").click());
		expect(page.rows()).toHaveLength(20);
		expect(page.host.textContent).toContain("Showing 20 of 20 installed apps");
		expect(page.buttonOrNull("Show more")).toBeNull();

		await page.search("fleet");
		expect(page.searches).toEqual(["fleet"]);
		expect(page.rows()).toHaveLength(15);
		expect(page.host.textContent).toContain("Showing 15 of 20 installed apps");
	});

	it("delegates the managed connection boundary to the Kumo collection", async () => {
		const { host } = await mountInRouter(
			<ConnectionsPanel manage />,
			(client) =>
				client.setQueryData(userConnectionsQueryOptions().queryKey, {
					data: [baseConnection],
				} as never),
		);
		const list = host.querySelector('[aria-label="Gateway connections"]');
		expect(list?.getAttribute("data-slot")).toBe("collection");
		expect(list?.className).toBe(
			kumoClass(<Collection aria-label="Gateway connections" />),
		);
		expect(list?.textContent).toContain("Gmail");
	});

	it("shows a scannable table and a mobile collection with visible actions", async () => {
		const page = await mountAppsPage({ apps: [baseApp] });
		const table = page.host.querySelector('[aria-label="Installed apps"]');
		expect(table?.getAttribute("data-slot")).toBe("table-container");
		expect(table?.textContent).toContain("Connection");
		expect(table?.textContent).toContain("Gateway");
		expect(table?.textContent).toContain("MCP service");
		const mobile = page.host.querySelector(
			'[aria-label="Installed apps mobile"]',
		);
		expect(mobile?.getAttribute("data-slot")).toBe("collection");
		expect(mobile?.textContent).toContain("Check MCP");
		expect(mobile?.textContent).toContain("Open");
		expect(page.rows()).toHaveLength(1);
		expect(page.host.querySelectorAll('[data-app-row="desktop"]')).toHaveLength(
			1,
		);
		expect(page.host.querySelectorAll('[data-app-row="mobile"]')).toHaveLength(
			1,
		);
	});

	it("keeps one capability navigator instead of a duplicate Browse apps CTA", async () => {
		const page = await mountAppsPage({ apps: [baseApp] });
		const current = page.host.querySelectorAll('[aria-current="page"]');
		expect([...current].map((element) => element.textContent)).toEqual([
			"Installed apps",
		]);
		expect(page.host.querySelector('[data-slot="page-actions"]')).toBeNull();
		const browse = [...page.host.querySelectorAll("a")].filter(
			(link) => link.getAttribute("href") === "/explore/apps",
		);
		expect(browse.length).toBeLessThanOrEqual(1);
		expect(browse[0]?.closest('[data-slot="page-header"]') ?? null).toBeNull();
	});

	it("retains the explicit MCP service probe action", async () => {
		const page = await mountAppsPage({ apps: [baseApp] });
		let finish!: (value: unknown) => void;
		mcpHealth.run.mockImplementationOnce(
			() => new Promise((resolve) => (finish = resolve)),
		);
		await act(async () => page.button("Check MCP service for Acme").click());
		expect(mcpHealth.run).toHaveBeenCalledWith({
			appSlug: "acme",
			authStrategy: "auto",
			tasksExtension: "ignore",
		});
		const checking = page.button("Checking MCP service for Acme");
		expect(checking.disabled).toBe(true);
		await act(async () =>
			finish({
				allPassed: true,
				passCount: 3,
				failCount: 0,
				checkedAt: "2026-08-12T10:00:00.000Z",
				toolCount: 4,
				results: [],
			}),
		);
		expect(page.button("Check MCP service for Acme").disabled).toBe(false);
		expect(page.host.textContent).toContain("Passed");
		expect(page.host.textContent).toContain("4 live tools");
		expect(page.host.textContent).toContain(
			"Provider API health and credential usability were not tested",
		);
		expect(page.host.textContent).not.toContain("Healthy");
	});

	it("uses the shared Kumo search control with a result count and honest no-match state", async () => {
		const page = await mountAppsPage({ apps: manyApps(3), hasMore: true });
		const input = page.host.querySelector<HTMLInputElement>(
			'input[aria-label="Search installed apps"]',
		);
		expect(input).not.toBeNull();
		expect(input?.closest('[data-slot="page-toolbar"]')).not.toBeNull();
		expect(
			input?.closest(".w-full.sm\\:max-w-sm"),
			"the search control keeps its responsive container",
		).not.toBeNull();
		expect(
			page.host.querySelector('[aria-label="3 results"]')?.textContent,
		).toBe("3");
		expect(page.host.textContent).toContain(
			"Search covers the first 3 loaded apps.",
		);
		expect(
			page.host.querySelector(
				'[data-slot="section-header"] [data-slot="badge"]',
			),
			"the result count lives in the search control, not a header badge",
		).toBeNull();

		await page.search("zebra");
		expect(page.host.querySelector('[aria-label="0 results"]')).not.toBeNull();
		expect(page.host.textContent).toContain(
			"No installed apps match this search",
		);
		expect(page.host.textContent).toContain(
			"No match among the first 3 loaded apps.",
		);
		await act(async () => page.button("Clear search").click());
		expect(page.searches).toEqual(["zebra", ""]);
		expect(page.rows()).toHaveLength(3);
	});
});

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	mcpHealth.run.mockReset();
});

const cleanups: Array<() => void> = [];

function kumoClass(element: React.ReactElement) {
	const host = document.createElement("div");
	host.innerHTML = renderToStaticMarkup(element);
	return (host.firstElementChild as HTMLElement).className;
}

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
	const rootRoute = createRootRoute({ component: () => element });
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
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
	return { host, queryClient };
}

async function mountAppsPage({
	apps,
	hasMore = false,
}: {
	apps: AppListItem[];
	hasMore?: boolean;
}) {
	const searches: string[] = [];
	function Harness() {
		const [q, setQ] = useState("");
		return (
			<AppsPage
				search={{ q }}
				onSearchChange={(query) => {
					searches.push(query);
					setQ(query);
				}}
			/>
		);
	}
	const { host } = await mountInRouter(<Harness />, (client) => {
		client.setQueryData(appListQueryOptions(50).queryKey, {
			data: apps,
			pagination: { hasMore, total: hasMore ? apps.length + 10 : apps.length },
		} as never);
		client.setQueryData(installedAppEligibilityQueryOptions().queryKey, []);
		client.setQueryData(appGatewayMembershipsQueryOptions().queryKey, {
			gateway: null,
			memberships: [],
		} as never);
		for (const scope of ["organization", "personal"] as const)
			client.setQueryData(
				connectionsOverviewQueryOptions({
					scope,
					q: "",
					status: "all",
					limit: 100,
					offset: 0,
				}).queryKey,
				{ rows: [] } as never,
			);
	});
	const buttonOrNull = (name: string) =>
		[...host.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) =>
				button.getAttribute("aria-label") === name ||
				button.textContent?.trim() === name,
		) ?? null;
	return {
		host,
		searches,
		rows: () =>
			[...host.querySelectorAll("li")].filter((row) =>
				row.querySelector('a[href^="/apps/"]'),
			),
		buttonOrNull,
		button: (name: string) => {
			const button = buttonOrNull(name);
			if (!button) throw new Error(`no ${name} button`);
			return button;
		},
		search: async (query: string) => {
			const input = host.querySelector<HTMLInputElement>(
				'input[aria-label="Search installed apps"]',
			)!;
			await act(async () => {
				const setValue = Object.getOwnPropertyDescriptor(
					HTMLInputElement.prototype,
					"value",
				)!.set!;
				setValue.call(input, query);
				input.dispatchEvent(new Event("input", { bubbles: true }));
			});
		},
	};
}
