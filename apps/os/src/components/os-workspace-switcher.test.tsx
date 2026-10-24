import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DirectoryWorkspaceRecord } from "@tedix/api-contract/contracts/directory";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const switchTo = vi.hoisted(() => vi.fn());
const directoryState = vi.hoisted(() => ({ loading: false }));

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

const otherWorkspace: DirectoryWorkspaceRecord = {
	org: {
		descopeTenantId: "org_northwind",
		logoUrl: null,
		name: "Northwind Labs",
		organizationId: "0f0f0f0f-0000-4000-8000-000000000002",
		provisionComplete: true,
		slug: "northwind",
	},
	surfaces: [],
};

vi.mock("@/shared/os-tenant", () => ({
	resolveOsTenant: () => ({ kind: "tenant", slug: "tedix" }),
}));

vi.mock("@/lib/workspace-switcher", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/workspace-switcher")>()),
	useSurfaceSwitch: () => ({ switchingTo: null, switchTo }),
	useWorkspaceDirectory: () => ({
		activeWorkspace: workspace,
		query: { isError: false, isLoading: directoryState.loading },
		workspaces: [workspace, otherWorkspace],
	}),
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

afterEach(() => {
	for (const root of roots.splice(0)) {
		act(() => root.unmount());
	}
	document.body.replaceChildren();
	directoryState.loading = false;
	vi.clearAllMocks();
});

describe("OsWorkspaceSwitcher", () => {
	it("opens the app menu without crossing a Base UI group boundary", async () => {
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
					<OsWorkspaceSwitcher>
						<span>Tedix organization</span>
					</OsWorkspaceSwitcher>
				</QueryClientProvider>,
			);
		});

		const trigger = container.querySelector<HTMLButtonElement>(
			'button[aria-label="Switch workspace or app"]',
		);
		expect(trigger).not.toBeNull();
		expect(trigger?.textContent).toContain("Tedix organization");

		await act(async () => {
			trigger?.click();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});

		expect(document.body.textContent).toContain("Workspaces and apps");
		expect(document.body.textContent).toContain("OS");
		expect(document.body.textContent).not.toContain("Tedix OS");
		expect(document.body.textContent).not.toContain("Dashboard");
		expect(document.body.textContent).toContain("CMS");
	});

	it("keeps the organization switcher available while the directory loads", async () => {
		directoryState.loading = true;
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
					<OsWorkspaceSwitcher>
						<span>Tedix organization</span>
					</OsWorkspaceSwitcher>
				</QueryClientProvider>,
			);
		});

		const trigger = container.querySelector<HTMLButtonElement>(
			'button[aria-label="Switch workspace or app"]',
		);
		expect(trigger).not.toBeNull();
		expect(trigger?.disabled).toBe(false);
		await act(async () => {
			trigger?.click();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(document.body.textContent).toContain("Loading workspaces…");
	});

	it("shows the current organization's logo and name, and each org's mark in the menu", async () => {
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
					<OsWorkspaceSwitcher>
						<OsOrganizationIdentity fallbackLabel="tedix" />
					</OsWorkspaceSwitcher>
				</QueryClientProvider>,
			);
		});

		const trigger = container.querySelector<HTMLButtonElement>(
			'button[aria-label="Switch workspace or app"]',
		);
		expect(trigger?.querySelector("strong")?.textContent).toBe("Tedix");
		expect(trigger?.querySelector("strong")?.getAttribute("title")).toBe(
			"Tedix",
		);
		const logo = trigger?.querySelector('[data-entity-kind="workspace"] img');
		expect(logo?.getAttribute("src")).toBe(
			"https://images.example.test/tedix-logo.png",
		);

		await act(async () => {
			trigger?.click();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		const menu = document.querySelector('[role="menu"]');
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
