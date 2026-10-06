import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OsWorkspace } from "@tedix/api-contract/schemas/os-workspaces";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";

const api = vi.hoisted(() => ({
	workspaces: { list: vi.fn() },
	workspacePreferences: { list: vi.fn() },
}));

vi.mock("@/lib/api", () => ({
	osApi: { osWorkspaces: api },
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	useNavigate: () => vi.fn(),
}));

import { SidebarProvider } from "./kumo/sidebar";
import { OsSidebarWorkspaces } from "./os-sidebar-workspaces";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const roots: Root[] = [];

function workspace(): OsWorkspace {
	return {
		id: WORKSPACE_ID,
		organizationId: "org-1",
		name: "Revenue Ops",
		description: "Weekly revenue reporting",
		status: "active",
		sourceBlueprintId: null,
		sourceBlueprintRevisionId: null,
		sourceBlueprintRevisionNumber: null,
		instantiationPreflight: null,
		rollbackReference: null,
		blueprintDecision: null,
		createdByKind: "user",
		createdById: "user-1",
		createdAt: "2026-08-01T10:00:00.000Z",
		updatedAt: "2026-08-12T10:00:00.000Z",
	};
}

async function flush() {
	await act(async () => {
		for (let tick = 0; tick < 5; tick += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	});
}

async function renderSidebar({ collapsed = false } = {}) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	act(() => {
		root.render(
			<QueryClientProvider client={queryClient}>
				<SidebarProvider defaultOpen={!collapsed}>
					<OsSidebarWorkspaces />
				</SidebarProvider>
			</QueryClientProvider>,
		);
	});
	await flush();
	return container;
}

function elementWithText(container: Element, selector: string, text: string) {
	return [...container.querySelectorAll<HTMLElement>(selector)].find(
		(element) => element.textContent?.trim() === text,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	api.workspaces.list.mockResolvedValue({
		items: [workspace()],
		truncated: false,
	});
	api.workspacePreferences.list.mockResolvedValue({
		items: [
			{
				workspaceId: WORKSPACE_ID,
				favorite: true,
				lastOpenedAt: "2026-08-17T12:00:00.000Z",
				updatedAt: "2026-08-17T12:00:00.000Z",
			},
		],
	});
});

afterEach(() => {
	for (const root of roots.splice(0)) {
		act(() => root.unmount());
	}
	document.body.replaceChildren();
});

describe("OsSidebarWorkspaces", () => {
	it("shows pinned workspaces directly without duplicate history or empty counters", async () => {
		const container = await renderSidebar();
		expect(container.textContent).toContain("Pinned workspaces");
		expect(
			container.querySelectorAll('[data-sidebar="menu-button"]'),
		).toHaveLength(1);
		expect(container.textContent).not.toContain("Recent workspaces");
		expect(container.textContent).not.toContain("Show all");
		expect(
			container.querySelector('[data-sidebar="menu-button"]')?.textContent,
		).toContain("Revenue Ops");
	});

	it("hides empty shortcut sections", async () => {
		api.workspaces.list.mockResolvedValue({ items: [], truncated: false });
		const container = await renderSidebar();
		expect(container.querySelector('[data-sidebar="group"]')).toBeNull();
	});

	it("keeps unpinned history in an explicitly scoped expandable section", async () => {
		api.workspacePreferences.list.mockResolvedValue({
			items: [
				{
					workspaceId: WORKSPACE_ID,
					favorite: false,
					lastOpenedAt: "2026-08-17T12:00:00.000Z",
				},
			],
		});
		const container = await renderSidebar();
		const recent = [...container.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("Recent workspaces"),
		);
		expect(recent?.getAttribute("aria-expanded")).toBe("false");
		act(() => recent?.click());
		await flush();
		expect(recent?.getAttribute("aria-expanded")).toBe("true");
		expect(
			container.querySelector('[data-sidebar="menu-sub-button"]')?.textContent,
		).toContain("Revenue Ops");
	});

	it("reports preference failures instead of presenting empty shortcuts", async () => {
		api.workspacePreferences.list.mockRejectedValue(new Error("unavailable"));
		const container = await renderSidebar();
		expect(container.textContent).toContain("Workspace shortcuts unavailable.");
	});

	it("collapses to icon-only workspace rows with a name tooltip", async () => {
		const container = await renderSidebar({ collapsed: true });

		expect(elementWithText(container, "span", "Revenue Ops")).toBeUndefined();
		const row = container.querySelector<HTMLElement>(
			'[data-sidebar="menu-button"]',
		);
		expect(row?.textContent?.trim()).toBe("RO");
		expect(row?.getAttribute("aria-label")).toBe("Open Revenue Ops");
	});
});
