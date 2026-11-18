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
	workspaces: {
		list: vi.fn(),
		update: vi.fn(),
		archive: vi.fn(),
		activity: vi.fn(),
	},
	workspacePreferences: { list: vi.fn(), setFavorite: vi.fn() },
	outputs: { list: vi.fn() },
}));
const unread = vi.hoisted(() => ({ summary: vi.fn(), markRead: vi.fn() }));
const webPush = vi.hoisted(() => ({
	getStatus: vi.fn(),
	setPreferences: vi.fn(),
}));
const collaborators = vi.hoisted(() => ({ list: vi.fn() }));
const navigate = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({
	osApi: {
		osWorkspaces: api,
		osCollaborators: collaborators,
		webPush,
		workspaceUnread: {
			summary: unread.summary,
			list: vi.fn(async () => ({ total: 0, groups: [] })),
			workspace: vi.fn(async ({ workspaceId }: { workspaceId: string }) => ({
				workspaceId,
				chat: 0,
				files: 0,
				total: 0,
				fileIds: [],
				conversations: [],
			})),
			markRead: unread.markRead,
			markAllRead: vi.fn(async () => ({ ok: true })),
		},
	},
}));
// Another change owns the share dialog; these tests only prove it opens.
vi.mock("@/components/workspace-share-dialog", () => ({
	WorkspaceShareDialog: ({ workspaceName }: { workspaceName: string }) => (
		<div role="dialog">Share {workspaceName}</div>
	),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	useNavigate: () => navigate,
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
		visibility: "org",
		ownerUserId: null,
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

/** Open a row's menu, from its "⋯" button or by right-click, and pick an entry. */
async function chooseAction(
	container: Element,
	label: string,
	how: "button" | "right-click" = "button",
) {
	await act(async () => {
		if (how === "button")
			container
				.querySelector<HTMLElement>('[aria-label="Actions for Revenue Ops"]')!
				.click();
		else
			container
				.querySelector<HTMLElement>("[data-workspace-row-menu]")!
				.dispatchEvent(
					new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
				);
	});
	const entry = [
		...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
	].find((node) => node.textContent?.trim() === label);
	expect(entry, label).toBeDefined();
	await act(async () => entry!.click());
	await flush();
}

function menuLabels() {
	return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(
		(node) => node.textContent?.trim(),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	unread.summary.mockResolvedValue({ total: 0, workspaces: [] });
	unread.markRead.mockImplementation(
		async ({ workspaceId }: { workspaceId: string }) => ({
			workspaceId,
			chat: 0,
			files: 0,
			total: 0,
			fileIds: [],
			conversations: [],
		}),
	);
	webPush.getStatus.mockResolvedValue({
		enabled: true,
		publicKey: "B".repeat(87),
		preferences: { mutedProjectIds: [], mutedWorkspaceIds: [] },
	});
	webPush.setPreferences.mockResolvedValue({
		mutedProjectIds: [],
		mutedWorkspaceIds: [WORKSPACE_ID],
	});
	api.workspacePreferences.setFavorite.mockImplementation(
		async (input: { workspaceId: string; favorite: boolean }) => ({
			preference: {
				...input,
				lastOpenedAt: null,
				updatedAt: "2026-10-21T12:00:00.000Z",
			},
		}),
	);
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
	it.each([false, true])(
		"opens stars beyond the sixth in one click (collapsed: %s)",
		async (collapsed) => {
			api.workspaces.list.mockResolvedValue({
				items: Array.from({ length: 8 }, (_, index) => ({
					...workspace(),
					id: `workspace-${index}`,
					name: `Workspace ${index}`,
				})),
				truncated: false,
			});
			api.workspacePreferences.list.mockResolvedValue({
				items: Array.from({ length: 8 }, (_, index) => ({
					workspaceId: `workspace-${index}`,
					favorite: true,
					lastOpenedAt: null,
				})),
			});
			const container = await renderSidebar({ collapsed });
			const rows = container.querySelectorAll<HTMLButtonElement>(
				'[data-sidebar="menu-button"]',
			);
			expect(rows).toHaveLength(8);
			act(() => rows[7]!.click());
			expect(navigate).toHaveBeenCalledWith({
				to: "/workspace/$workspaceId",
				params: { workspaceId: "workspace-7" },
			});
		},
	);

	it.each([false, true])(
		"names omitted recent workspaces and opens the full library (collapsed: %s)",
		async (collapsed) => {
			api.workspaces.list.mockResolvedValue({
				items: Array.from({ length: 9 }, (_, index) => ({
					...workspace(),
					id: `workspace-${index}`,
					name: `Workspace ${index}`,
				})),
				truncated: false,
			});
			api.workspacePreferences.list.mockResolvedValue({
				items: Array.from({ length: 9 }, (_, index) => ({
					workspaceId: `workspace-${index}`,
					favorite: false,
					lastOpenedAt: `2026-08-1${index}T12:00:00.000Z`,
				})),
			});
			const container = await renderSidebar({ collapsed });
			if (!collapsed) {
				const recent = [...container.querySelectorAll("button")].find(
					(button) => button.textContent?.includes("Recent workspaces"),
				);
				act(() => recent?.click());
				await flush();
			}
			const overflow = collapsed
				? container.querySelector<HTMLElement>(
						'[aria-label="Show all workspaces, 3 more"]',
					)
				: [
						...container.querySelectorAll<HTMLElement>(
							'[data-sidebar="menu-sub-button"]',
						),
					].find((row) => row.textContent?.includes("Show all workspaces"));
			expect(overflow).toBeTruthy();
			if (!collapsed) expect(overflow?.textContent).toContain("3 more");
			act(() => overflow!.click());
			expect(navigate).toHaveBeenCalledWith({ to: "/workspaces" });
		},
	);

	it("shows pinned workspaces directly without duplicate history or empty counters", async () => {
		const container = await renderSidebar();
		const pinnedWorkspace = container.querySelector<HTMLElement>(
			'[data-sidebar="menu-button"]',
		);
		expect(container.textContent).toContain("Pinned workspaces");
		expect(
			container.querySelectorAll('[data-sidebar="menu-button"]'),
		).toHaveLength(1);
		expect(container.textContent).not.toContain("Recent workspaces");
		expect(container.textContent).not.toContain("Show all");
		expect(pinnedWorkspace?.textContent).toContain("Revenue Ops");
		expect(pinnedWorkspace?.getAttribute("title")).toBe("Revenue Ops");
		expect(container.querySelector('[aria-label="Favorite"]')).toBeNull();
	});

	it("announces loading until workspace shortcuts are available", async () => {
		let finish!: (value: { items: OsWorkspace[]; truncated: boolean }) => void;
		api.workspaces.list.mockReturnValue(
			new Promise((resolve) => {
				finish = resolve;
			}),
		);
		const container = await renderSidebar();
		expect(
			container.querySelector('[role="status"]')?.getAttribute("aria-label"),
		).toBe("Loading workspace shortcuts");
		expect(container.textContent).not.toContain("Revenue Ops");
		await act(async () => {
			finish({ items: [workspace()], truncated: false });
		});
		await flush();
		expect(container.querySelector('[role="status"]')).toBeNull();
		expect(container.textContent).toContain("Revenue Ops");
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
			container.querySelector(
				'[data-sidebar="menu-sub"] [data-sidebar="menu-button"]',
			)?.textContent,
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

	it("counts what is new on a pinned row", async () => {
		unread.summary.mockResolvedValue({
			total: 3,
			workspaces: [{ workspaceId: WORKSPACE_ID, chat: 2, files: 1, total: 3 }],
		});
		const container = await renderSidebar();
		const pinned = container.querySelector<HTMLElement>(
			'[data-sidebar="menu-button"]',
		);
		expect(
			pinned?.querySelector('[aria-label="3 unread in Revenue Ops"]')
				?.textContent,
		).toBe("3");
	});

	it("marks a workspace with something new by a dot on the narrow sidebar", async () => {
		unread.summary.mockResolvedValue({
			total: 3,
			workspaces: [{ workspaceId: WORKSPACE_ID, chat: 2, files: 1, total: 3 }],
		});
		const container = await renderSidebar({ collapsed: true });
		const row = container.querySelector<HTMLElement>(
			'[data-sidebar="menu-button"]',
		);
		expect(
			row?.querySelector('[role="img"][aria-label="3 unread in Revenue Ops"]'),
		).not.toBeNull();
		// The dot adds no text: the row is still only the workspace's mark.
		expect(row?.textContent?.trim()).toBe("RO");
	});

	it("shows no dot on the narrow sidebar when nothing is new", async () => {
		const container = await renderSidebar({ collapsed: true });
		expect(container.querySelector('[role="img"]')).toBeNull();
	});

	it("offers every workspace action from the row's menu", async () => {
		const container = await renderSidebar();
		await act(async () => {
			container
				.querySelector<HTMLElement>('[aria-label="Actions for Revenue Ops"]')!
				.click();
		});
		expect(menuLabels()).toEqual([
			"Rename",
			"Unpin",
			"Mute",
			"Mark as read",
			"Share",
			"Information",
			"Archive",
		]);
		// Opening the menu is not opening the workspace.
		expect(navigate).not.toHaveBeenCalled();
	});

	it("unpins, mutes and marks a workspace read without opening it", async () => {
		unread.summary.mockResolvedValue({
			total: 3,
			workspaces: [{ workspaceId: WORKSPACE_ID, chat: 2, files: 1, total: 3 }],
		});
		const container = await renderSidebar();

		await chooseAction(container, "Mark as read");
		expect(unread.markRead.mock.calls[0]?.[0]).toEqual({
			workspaceId: WORKSPACE_ID,
			target: { type: "all" },
		});

		await chooseAction(container, "Mute");
		expect(webPush.setPreferences).toHaveBeenCalledWith({
			mutedProjectIds: [],
			mutedWorkspaceIds: [WORKSPACE_ID],
		});

		await chooseAction(container, "Unpin");
		expect(api.workspacePreferences.setFavorite.mock.calls[0]?.[0]).toEqual({
			workspaceId: WORKSPACE_ID,
			favorite: false,
		});
		expect(navigate).not.toHaveBeenCalled();
	});

	it("offers Unmute for a muted workspace and Pin for a recent one", async () => {
		webPush.getStatus.mockResolvedValue({
			enabled: true,
			publicKey: "B".repeat(87),
			preferences: { mutedProjectIds: [], mutedWorkspaceIds: [WORKSPACE_ID] },
		});
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
		act(() => recent?.click());
		await flush();

		await chooseAction(container, "Unmute");
		expect(webPush.setPreferences).toHaveBeenCalledWith({
			mutedProjectIds: [],
			mutedWorkspaceIds: [],
		});
		await chooseAction(container, "Pin");
		expect(api.workspacePreferences.setFavorite.mock.calls[0]?.[0]).toEqual({
			workspaceId: WORKSPACE_ID,
			favorite: true,
		});
	});

	it("renames a workspace from its row", async () => {
		api.workspaces.update.mockResolvedValue({
			workspace: { ...workspace(), name: "Revenue" },
		});
		const container = await renderSidebar();
		await chooseAction(container, "Rename");
		const name = document.querySelector<HTMLInputElement>(
			'[role="dialog"] input',
		)!;
		expect(name.value).toBe("Revenue Ops");
		act(() => {
			Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)!.set!.call(name, "Revenue");
			name.dispatchEvent(new Event("input", { bubbles: true }));
		});
		const save = [...document.querySelectorAll("button")].find(
			(button) => button.textContent === "Save changes",
		);
		await act(async () => save!.click());
		await flush();
		expect(api.workspaces.update).toHaveBeenCalledWith({
			workspaceId: WORKSPACE_ID,
			name: "Revenue",
			description: "Weekly revenue reporting",
		});
	});

	it("opens sharing and the workspace's information from its row", async () => {
		collaborators.list.mockResolvedValue({
			role: "owner",
			isOwner: true,
			ownerName: "Ada Lovelace",
			collaborators: [],
			links: [],
		});
		api.outputs.list.mockResolvedValue({ items: [], truncated: false });
		api.workspaces.activity.mockResolvedValue({
			items: [],
			coverage: "recorded_only",
			next: null,
		});
		const container = await renderSidebar();
		await chooseAction(container, "Share");
		expect(document.body.textContent).toContain("Share Revenue Ops");
		await chooseAction(container, "Information");
		expect(document.body.textContent).toContain("About Revenue Ops");
		expect(document.body.textContent).toContain("Ada Lovelace");
	});

	it("archives a workspace from a right-click on the narrow sidebar, after asking", async () => {
		api.workspaces.archive.mockResolvedValue({
			workspace: { ...workspace(), status: "archived" },
		});
		const container = await renderSidebar({ collapsed: true });
		// The narrow sidebar has no room for a "⋯" button.
		expect(
			container.querySelector('[aria-label="Actions for Revenue Ops"]'),
		).toBeNull();
		await chooseAction(container, "Archive", "right-click");
		expect(api.workspaces.archive).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain("Nothing is deleted");
		const confirm = [...document.querySelectorAll("button")].find(
			(button) => button.textContent === "Archive workspace",
		);
		await act(async () => confirm!.click());
		await flush();
		expect(api.workspaces.archive).toHaveBeenCalledWith({
			workspaceId: WORKSPACE_ID,
		});
	});
});
