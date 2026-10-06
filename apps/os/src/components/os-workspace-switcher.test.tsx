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

vi.mock("@/shared/os-tenant", () => ({
	resolveOsTenant: () => ({ kind: "tenant", slug: "tedix" }),
}));

vi.mock("@/lib/workspace-switcher", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/workspace-switcher")>()),
	useSurfaceSwitch: () => ({ switchingTo: null, switchTo }),
	useWorkspaceDirectory: () => ({
		activeWorkspace: workspace,
		query: { isError: false, isLoading: directoryState.loading },
		workspaces: [workspace],
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
});
