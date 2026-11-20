import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DirectoryWorkspaceRecord } from "@tedix/api-contract/contracts/directory";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const switchTo = vi.hoisted(() => vi.fn());
const directoryState = vi.hoisted(() => ({
	loading: false,
	role: "owner",
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
		],
	};
}

const otherWorkspace = organization(2, "Northwind Labs");

vi.mock("@/shared/os-tenant", () => ({
	resolveOsTenant: () => ({ kind: "tenant", slug: "tedix" }),
}));

vi.mock("@/lib/workspace-switcher", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("@/lib/workspace-switcher")>();
	return {
		...original,
		useSurfaceSwitch: () => original.useSurfaceSwitch({ navigate: switchTo }),
		useWorkspaceDirectory: () => ({
			activeWorkspace: workspace,
			query: { isError: false, isLoading: directoryState.loading },
			workspaces: directoryState.workspaces ?? [otherWorkspace, workspace],
		}),
	};
});

vi.mock("@/lib/use-os-preferences", () => ({
	useOsOperationalContext: () => ({
		data: { authority: { role: directoryState.role, permissions: [] } },
	}),
}));

vi.mock("@/components/kumo/link-provider", () => ({
	OsRouterLink: ({ to, ...props }: { to: string }) => (
		<a href={to} {...props} />
	),
}));

vi.mock("@/lib/api", () => ({
	osApi: { directory: { listMyWorkspaces: vi.fn() } },
}));

vi.mock("@/lib/os-query-options", () => ({
	myWorkspacesDirectoryQueryOptions: () => ({
		queryKey: ["directory", "listMyWorkspaces"],
	}),
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
	directoryState.role = "owner";
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
	it("lists one row per organization, current first, with no CMS entry", async () => {
		const { menu } = await openSwitcher();

		expect(rowNames(menu)).toEqual(["tedix", "northwind-labs"]);
		const items = [...(menu?.querySelectorAll('[role="menuitem"]') ?? [])];
		expect(
			items.map(
				(item) =>
					item.querySelector("[title]")?.textContent ?? item.textContent,
			),
		).toEqual([
			"Tedix",
			"Northwind Labs",
			"Organization settings",
			"Create organization",
		]);
		expect(items[0]?.getAttribute("aria-current")).toBe("true");
		// Kumo's selected check; the other row has none.
		expect(items[0]?.querySelector("svg")).not.toBeNull();
		expect(items[1]?.querySelector("svg")).toBeNull();
		expect(
			menu?.querySelector('[role="group"]')?.getAttribute("aria-labelledby"),
		).toBe(
			[...(menu?.querySelectorAll("[id]") ?? [])].find(
				(element) => element.textContent === "Organizations",
			)?.id,
		);
		expect(menu?.querySelector('[role="separator"]')).not.toBeNull();
		expect(items[2]?.getAttribute("href")).toBe("/admin/organization");
		expect(items[3]?.getAttribute("href")).toBe("/account/onboarding?new=1");
		expect(menu?.textContent).not.toContain("OS");
		expect(menu?.textContent).not.toContain("CMS");
		expect(menu?.querySelector('input[type="text"], input')).toBeNull();
	});

	it("shows no tooltip on the trigger and no settings link to a member", async () => {
		directoryState.role = "member";
		const { menu, trigger } = await openSwitcher(
			<OsOrganizationIdentity fallbackLabel="tedix" />,
		);

		expect(trigger?.getAttribute("title")).toBeNull();
		expect(trigger?.querySelector("[title]")).toBeNull();
		expect(document.querySelector('[role="tooltip"]')).toBeNull();
		expect(menu?.querySelector('a[href="/admin/organization"]')).toBeNull();
		expect(
			menu?.querySelector('a[href="/account/onboarding?new=1"]'),
		).not.toBeNull();
	});

	it("opens another organization's OS", async () => {
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
		await act(async () => again[1]?.click());
		expect(switchTo).toHaveBeenLastCalledWith(
			otherWorkspace.surfaces[0]?.handoffUrl,
		);
		expect(document.querySelector('[role="menu"]')).not.toBeNull();
		const picked = document.querySelector('[data-org-row="northwind-labs"]');
		expect(picked?.getAttribute("aria-busy")).toBe("true");
		expect(
			picked?.querySelector('[aria-label="Switching organization"]'),
		).not.toBeNull();
		expect(
			document.querySelector(
				'[data-org-row="tedix"] [aria-label="Switching organization"]',
			),
		).toBeNull();
		for (const row of document.querySelectorAll("[data-org-row]")) {
			expect(row.getAttribute("aria-disabled")).toBe("true");
		}
		await act(async () => again[1]?.click());
		expect(switchTo).toHaveBeenCalledTimes(1);
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
		const search = document.querySelector<HTMLInputElement>(
			'input[aria-label="Search organizations"]',
		);
		expect(search?.getAttribute("role")).toBe("searchbox");
		expect(search?.closest('[data-slot="input-group"]')).not.toBeNull();
		const clear = () =>
			document.querySelector<HTMLElement>(
				'[aria-label="Clear organization search"]',
			);
		expect(clear()).toBeNull();

		await act(async () => {
			Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)!.set!.call(search, "elm");
			search!.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(rowNames(menu)).toEqual(["elm-clinic"]);
		expect(menu?.querySelectorAll('[role="menuitem"]')).toHaveLength(1);
		const footer = menu
			?.querySelector('[role="separator"]')
			?.closest('[role="group"]');
		expect(footer?.hasAttribute("hidden")).toBe(true);

		await act(async () => clear()?.click());
		expect(search?.value).toBe("");
		expect(document.activeElement).toBe(search);
		expect(clear()).toBeNull();
		expect(footer?.hasAttribute("hidden")).toBe(false);
		expect(rowNames(menu)).toHaveLength(7);
		expect(menu?.querySelectorAll('[role="menuitem"]')).toHaveLength(9);
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
