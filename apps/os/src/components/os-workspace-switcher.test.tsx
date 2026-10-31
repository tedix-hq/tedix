import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DirectoryWorkspaceRecord } from "@tedix/api-contract/contracts/directory";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const switchTo = vi.hoisted(() => vi.fn());
const directoryState = vi.hoisted(() => ({
	loading: false,
	workspaces: null as unknown[] | null,
}));

const workspace: DirectoryWorkspaceRecord = {
	org: {
		descopeTenantId: "org_tedix",
		logoUrl: "https://images.example.test/tedix-logo.png",
		name: "Tedix",
		organizationId: "0f0f0f0f-0000-4000-8000-000000000001",
		provisionComplete: true,
		slug: "tedix",
	},
	surfaces: [
		{
			canonicalUrl: "https://tedix.os.tedix.dev/",
			handoffUrl:
				"https://tedix.os.tedix.dev/auth/session-broker/start?tenant_id=org_tedix&redirect_to=%2F",
			provisioned: true,
			surface: "os",
		},
		{
			canonicalUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
			handoffUrl: null,
			provisioned: true,
			surface: "mcp",
		},
		{
			canonicalUrl: "https://blog.tedix.dev/_emdash/admin",
			handoffUrl:
				"https://tedix.cms.tedix.dev/_emdash/api/auth/session-broker/start?tenant_id=org_tedix&redirect_to=%2F_emdash%2Fadmin",
			provisioned: true,
			surface: "cms",
		},
	],
};

function organization(index: number, name: string): DirectoryWorkspaceRecord {
	const slug = name.toLowerCase().replaceAll(" ", "-");
	return {
		org: {
			descopeTenantId: `org_${slug}`,
			logoUrl: null,
			name,
			organizationId: `0f0f0f0f-0000-4000-8000-${String(index).padStart(12, "0")}`,
			provisionComplete: true,
			slug,
		},
		surfaces: [
			{
				canonicalUrl: `https://${slug}.os.tedix.dev/`,
				handoffUrl: `https://${slug}.os.tedix.dev/auth/session-broker/start`,
				provisioned: true,
				surface: "os",
			},
			{
				canonicalUrl: null,
				handoffUrl: null,
				provisioned: false,
				surface: "cms",
			},
		],
	};
}

const otherWorkspace = organization(2, "Northwind Labs");

vi.mock("@/shared/os-tenant", () => ({
	resolveOsTenant: () => ({ kind: "tenant", slug: "tedix" }),
}));

vi.mock("@/lib/workspace-switcher", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/workspace-switcher")>()),
	useSurfaceSwitch: () => ({ switchingTo: null, switchTo }),
	useWorkspaceDirectory: () => ({
		activeWorkspace: workspace,
		query: { isError: false, isLoading: directoryState.loading },
		workspaces: directoryState.workspaces ?? [otherWorkspace, workspace],
	}),
}));

vi.mock("@/lib/api", () => ({
	osApi: { directory: { listMyWorkspaces: vi.fn() } },
}));

vi.mock("@/lib/os-query-options", () => ({
	myWorkspacesDirectoryQueryOptions: () => ({
		queryKey: ["directory", "listMyWorkspaces"],
	}),
	operationalContextQueryOptions: () => ({
		queryKey: ["operational-context"],
		queryFn: async () => ({
			authority: { role: "owner", permissions: [] },
		}),
	}),
}));

vi.mock("@/components/kumo/link-provider", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/kumo/link-provider")>()),
	OsRouterLink: ({
		to,
		search,
		...props
	}: {
		to: string;
		search?: Record<string, unknown>;
	}) => <a href={`${to}${search?.new ? "?new=1" : ""}`} {...props} />,
}));

import { OsOrganizationIdentity } from "./os-organization-identity";
import { OsWorkspaceSwitcher } from "./os-workspace-switcher";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function unmountAll() {
	for (const root of roots.splice(0)) {
		act(() => root.unmount());
	}
	document.body.replaceChildren();
}

afterEach(() => {
	unmountAll();
	directoryState.loading = false;
	directoryState.workspaces = null;
	vi.clearAllMocks();
});

async function openSwitcher(children: ReactNode = <span>Tedix</span>) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => {
		root.render(
			<QueryClientProvider client={queryClient}>
				<OsWorkspaceSwitcher>{children}</OsWorkspaceSwitcher>
			</QueryClientProvider>,
		);
	});
	const trigger = container.querySelector<HTMLButtonElement>(
		'button[aria-label="Switch organization"]',
	);
	expect(trigger).not.toBeNull();
	expect(trigger?.disabled).toBe(false);
	await act(async () => {
		trigger?.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	return { menu: document.querySelector('[role="menu"]'), trigger };
}

function rowNames(menu: Element | null) {
	return [...(menu?.querySelectorAll("[data-org-row]") ?? [])].map((row) =>
		row.getAttribute("data-org-row"),
	);
}

describe("OsWorkspaceSwitcher", () => {
	it("lists one row per organization, current first, with CMS only where it is provisioned", async () => {
		const { menu } = await openSwitcher();

		expect(rowNames(menu)).toEqual(["tedix", "northwind-labs"]);
		const items = [...(menu?.querySelectorAll('[role="menuitem"]') ?? [])];
		expect(
			items.map(
				(item) =>
					item.getAttribute("aria-label") ??
					item.querySelector("[title]")?.textContent ??
					item.textContent,
			),
		).toEqual([
			"Tedix",
			"Open Tedix CMS",
			"Northwind Labs",
			"Organization settings",
			"Create organization",
		]);
		expect(items[0]?.getAttribute("aria-current")).toBe("true");
		expect(menu?.querySelector('a[href="/admin/organization"]')).not.toBeNull();
		expect(
			menu?.querySelector('a[href="/account/onboarding?new=1"]'),
		).not.toBeNull();
		expect(menu?.textContent).not.toContain("OS");
		expect(menu?.querySelector('input[type="text"], input')).toBeNull();
	});

	it("opens an organization's OS by default and its CMS from the trailing chip", async () => {
		const { menu } = await openSwitcher();
		const items = [
			...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
		];

		await act(async () => items[0]?.click());
		expect(switchTo).not.toHaveBeenCalled();

		unmountAll();
		const reopened = await openSwitcher();
		const again = [
			...(reopened.menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ??
				[]),
		];
		await act(async () => again[2]?.click());
		expect(switchTo).toHaveBeenLastCalledWith(otherWorkspace, "os");

		unmountAll();
		const third = await openSwitcher();
		await act(async () =>
			third.menu
				?.querySelector<HTMLElement>('[aria-label="Open Tedix CMS"]')
				?.click(),
		);
		expect(switchTo).toHaveBeenLastCalledWith(workspace, "cms");
	});

	it("adds a search field once there are more than six organizations", async () => {
		directoryState.workspaces = [
			workspace,
			...[
				"Alder Works",
				"Birch Studio",
				"Cedar Supply",
				"Dune Freight",
				"Elm Clinic",
				"Fjord Bakery",
			].map((name, index) => organization(index + 10, name)),
		];
		const { menu } = await openSwitcher();
		expect(rowNames(menu)).toHaveLength(7);
		expect(
			document.querySelector('input[aria-label="Search organizations"]'),
		).not.toBeNull();
	});

	it("keeps the organization switcher available while the directory loads", async () => {
		directoryState.loading = true;
		directoryState.workspaces = [];
		await openSwitcher();
		expect(document.body.textContent).toContain("Loading organizations…");
	});

	it("shows the current organization's logo and name, and each org's mark in the menu", async () => {
		const { menu, trigger } = await openSwitcher(
			<OsOrganizationIdentity fallbackLabel="tedix" />,
		);

		expect(trigger?.querySelector("strong")?.textContent).toBe("Tedix");
		expect(trigger?.querySelector("strong")?.getAttribute("title")).toBeNull();
		const logo = trigger?.querySelector('[data-entity-kind="workspace"] img');
		expect(logo?.getAttribute("src")).toBe(
			"https://images.example.test/tedix-logo.png",
		);
		expect(
			menu
				?.querySelector('[data-entity-kind="workspace"] img')
				?.getAttribute("src"),
		).toBe("https://images.example.test/tedix-logo.png");
		expect(menu?.textContent).toContain("Northwind Labs");
		expect(
			menu?.querySelector('[data-entity-kind="workspace"] span')?.textContent,
		).toBe("NL");

		await act(async () => {
			logo?.dispatchEvent(new Event("error"));
		});
		expect(
			trigger?.querySelector('[data-entity-kind="workspace"] img'),
		).toBeNull();
		expect(
			trigger?.querySelector('[data-entity-kind="workspace"] span')
				?.textContent,
		).toBe("TE");
	});
});
