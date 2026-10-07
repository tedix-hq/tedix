import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OsWorkspace } from "@tedix/api-contract/schemas/os-workspaces";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";

const api = vi.hoisted(() => ({
	workspaces: { list: vi.fn(), restore: vi.fn() },
	workspacePreferences: {
		list: vi.fn(),
		setFavorite: vi.fn(),
	},
	blueprints: { list: vi.fn() },
}));
const navigate = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({
	osApi: { osWorkspaces: api },
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	useNavigate: () => navigate,
}));
vi.mock("@/components/canvas-workspace-controls", () => ({
	CanvasWorkspaceControls: ({
		onSelected,
	}: {
		onSelected: (id: string) => void;
	}) => (
		<button type="button" onClick={() => onSelected(WORKSPACE_ID)}>
			New workspace
		</button>
	),
}));

import {
	WorkspaceLibraryPage,
	WORKSPACES_VISIBLE_PAGE_SIZE,
} from "./workspace-library-page";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECOND_WORKSPACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function workspace(overrides: Partial<OsWorkspace> = {}): OsWorkspace {
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
		...overrides,
	};
}

async function flush() {
	await act(async () => {
		for (let tick = 0; tick < 5; tick += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	});
}

function click(element: Element) {
	act(() => {
		element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
}

function setFieldValue(field: HTMLInputElement, value: string) {
	act(() => {
		const setter = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set;
		setter?.call(field, value);
		field.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

async function renderPage() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	act(() => {
		root.render(
			<QueryClientProvider client={queryClient}>
				<WorkspaceLibraryPage />
			</QueryClientProvider>,
		);
	});
	await flush();
	return { container, root, queryClient };
}

beforeEach(() => {
	vi.clearAllMocks();
	api.workspaces.list.mockResolvedValue({
		items: [
			workspace(),
			workspace({
				id: SECOND_WORKSPACE_ID,
				name: "Support Desk",
				description: "Customer triage",
			}),
		],
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
	api.workspacePreferences.setFavorite.mockResolvedValue({});
	api.blueprints.list.mockResolvedValue({
		items: [
			{
				id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
				name: "Revenue Ops Starter",
				description: "A governed reporting workspace",
				status: "published",
			},
		],
		truncated: false,
	});
});

afterEach(() => {
	document.body.innerHTML = "";
});

describe("WorkspaceLibraryPage", () => {
	it("uses the full page lane and progressively discloses a long library", async () => {
		api.workspaces.list.mockResolvedValue({
			items: Array.from({ length: 18 }, (_, index) =>
				workspace({
					id: `workspace-${index}`,
					name: `Workspace ${index + 1}`,
				}),
			),
			truncated: false,
		});
		api.workspacePreferences.list.mockResolvedValue({ items: [] });
		const { container, root } = await renderPage();
		const list = container.querySelector('ul[aria-label="Workspaces"]');
		const search = container.querySelector(
			'input[aria-label="Search workspaces"]',
		);
		if (!(search instanceof HTMLInputElement))
			throw new Error("search missing");

		expect(list?.children).toHaveLength(WORKSPACES_VISIBLE_PAGE_SIZE);
		expect(container.textContent).toContain("Showing 15 of 18 workspaces");
		expect(
			search.closest('[data-kumo-component="SearchInput"]')?.parentElement
				?.className,
		).not.toContain("px-3");
		const showMore = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Show more",
		);
		if (!showMore) throw new Error("Show more missing");
		click(showMore);
		expect(list?.children).toHaveLength(18);
		setFieldValue(search, "Workspace");
		expect(list?.children).toHaveLength(WORKSPACES_VISIBLE_PAGE_SIZE);
		act(() => root.unmount());
	});

	it("searches, favorites, and opens a workspace through its canonical route", async () => {
		const { container, root } = await renderPage();
		expect(container.textContent).toContain("Revenue Ops");
		expect(container.textContent).toContain("Support Desk");

		const search = container.querySelector(
			'input[aria-label="Search workspaces"]',
		);
		if (!(search instanceof HTMLInputElement))
			throw new Error("search missing");
		expect(search.className).not.toContain("max-w-md");
		const searchGroup = search.closest('[data-kumo-component="SearchInput"]');
		expect(searchGroup?.className).toContain("sm:max-w-md");
		expect(searchGroup?.parentElement?.className).not.toContain("px-3");
		expect(searchGroup?.parentElement?.className).toContain("gap-4");
		expect(
			container.querySelector('ul[aria-label="Workspaces"]'),
		).not.toBeNull();
		expect(container.querySelector("strong")?.className).toContain(
			"type-tedix-body",
		);
		setFieldValue(search, "support");
		await flush();
		expect(container.textContent).not.toContain("Weekly revenue reporting");
		expect(container.textContent).toContain("Customer triage");

		const favorite = container.querySelector(
			'button[aria-label="Add Support Desk to favorites"]',
		);
		if (!favorite) throw new Error("favorite action missing");
		click(favorite);
		await flush();
		expect(api.workspacePreferences.setFavorite).toHaveBeenCalledWith(
			{
				workspaceId: SECOND_WORKSPACE_ID,
				favorite: true,
			},
			expect.anything(),
		);

		const open = container.querySelector(
			`a[href="/workspace/${SECOND_WORKSPACE_ID}"]`,
		);
		if (!open) throw new Error("workspace row missing");
		expect(open.getAttribute("data-link-role")).toBe("collection");
		expect(open.getAttribute("role")).toBeNull();
		expect(open.textContent).toContain("Support Desk");
		act(() => root.unmount());
	});

	it("pairs a simple empty state with the template entry", async () => {
		api.workspaces.list.mockResolvedValue({ items: [], truncated: false });
		const { container, root } = await renderPage();
		expect(
			container
				.querySelector('[data-slot="empty"]')
				?.getAttribute("data-appearance"),
		).toBe("quiet");
		expect(container.textContent).toContain("No workspaces yet");
		expect(container.textContent).toContain("Browse templates");
		expect(container.textContent).toContain(
			"Create a workspace or start from a template.",
		);
		expect(container.textContent).not.toContain("governed");
		expect(container.textContent).not.toContain("Revenue Ops Starter");

		const browse = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.includes("Browse templates"),
		);
		if (!browse) throw new Error("blueprint entry missing");
		click(browse);
		expect(navigate).toHaveBeenCalledWith({ to: "/blueprints" });
		act(() => root.unmount());
	});

	it("lists archived workspaces and restores one", async () => {
		const archivedWorkspace = workspace({
			id: SECOND_WORKSPACE_ID,
			name: "Old Probe",
			status: "archived",
		});
		api.workspaces.list.mockImplementation(
			async (input: { status?: string }) =>
				input.status === "archived"
					? { items: [archivedWorkspace], truncated: false }
					: { items: [workspace()], truncated: false },
		);
		api.workspaces.restore.mockResolvedValue({
			workspace: { ...archivedWorkspace, status: "active" },
		});
		const { container, root } = await renderPage();
		expect(container.textContent).not.toContain("Old Probe");

		const archivedTab = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Archived",
		);
		if (!archivedTab) throw new Error("Archived view missing");
		click(archivedTab);
		await flush();
		expect(
			container.querySelector('ul[aria-label="Archived workspaces"]')
				?.textContent,
		).toContain("Old Probe");

		const restore = container.querySelector(
			'button[aria-label="Restore Old Probe"]',
		);
		if (!restore) throw new Error("Restore button missing");
		const listCalls = api.workspaces.list.mock.calls.length;
		click(restore);
		await flush();
		expect(api.workspaces.restore).toHaveBeenCalledWith(
			{ workspaceId: SECOND_WORKSPACE_ID },
			expect.anything(),
		);
		// The shared workspaces key refreshes the lists after a restore.
		expect(api.workspaces.list.mock.calls.length).toBeGreaterThan(listCalls);
		act(() => root.unmount());
	});

	it("explains an empty archive", async () => {
		api.workspaces.list.mockImplementation(
			async (input: { status?: string }) =>
				input.status === "archived"
					? { items: [], truncated: false }
					: { items: [workspace()], truncated: false },
		);
		const { container, root } = await renderPage();
		const archivedTab = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Archived",
		);
		if (!archivedTab) throw new Error("Archived view missing");
		click(archivedTab);
		await flush();
		expect(container.textContent).toContain("No archived workspaces");
		act(() => root.unmount());
	});

	it("keeps server truncation explicit", async () => {
		api.workspaces.list.mockResolvedValue({
			items: [workspace()],
			truncated: true,
		});
		const { container, root } = await renderPage();
		expect(container.textContent).toContain(
			"Showing the first 1 workspace — more exist beyond this page.",
		);
		act(() => root.unmount());
	});
});
