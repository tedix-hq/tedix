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
vi.mock("@/components/shared-workspaces-list", () => ({
	SharedWorkspacesList: () => null,
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
		visibility: "org",
		ownerUserId: null,
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
	api.workspacePreferences.setFavorite.mockImplementation(
		async (input: { workspaceId: string; favorite: boolean }) => ({
			preference: {
				...input,
				lastOpenedAt: null,
				updatedAt: "2026-10-21T12:00:00.000Z",
			},
		}),
	);
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
	it("marks the member's own private workspace as Only you", async () => {
		api.workspaces.list.mockResolvedValue({
			items: [
				workspace(),
				workspace({
					id: SECOND_WORKSPACE_ID,
					name: "Robin (private)",
					visibility: "private",
					ownerUserId: "user-1",
				}),
			],
			truncated: false,
		});
		const { container, root } = await renderPage();
		const rows = Array.from(
			container.querySelectorAll('ul[aria-label="Workspaces"] > li'),
		);
		const privateRow = rows.find((row) =>
			row.textContent?.includes("Robin (private)"),
		);
		const orgRow = rows.find((row) => row.textContent?.includes("Revenue Ops"));
		expect(privateRow?.textContent).toContain("Only you");
		expect(orgRow?.textContent).not.toContain("Only you");
		act(() => root.unmount());
	});

	it("puts stars before alphabetical rows and moves them before saving, with rollback", async () => {
		api.workspaces.list.mockResolvedValue({
			items: [
				workspace({ id: "plain-z", name: "Zulu" }),
				workspace({ id: "star-z", name: "Zebra" }),
				workspace({ id: "plain-a", name: "Alpha" }),
				workspace({ id: "star-b", name: "Beta" }),
			],
			truncated: false,
		});
		let items = ["star-z", "star-b"].map((workspaceId) => ({
			workspaceId,
			favorite: true,
			lastOpenedAt: null,
			updatedAt: "2026-10-24",
		}));
		api.workspacePreferences.list.mockImplementation(async () => ({ items }));
		let resolveSave!: () => void;
		let rejectSave!: (error: Error) => void;
		api.workspacePreferences.setFavorite.mockImplementation(
			() =>
				new Promise<{ preference: (typeof items)[number] }>(
					(resolve, reject) => {
						resolveSave = () =>
							resolve({ preference: items[items.length - 1]! });
						rejectSave = reject;
					},
				),
		);
		const { container, root } = await renderPage();
		const names = () =>
			[...container.querySelectorAll('ul[aria-label="Workspaces"] strong')].map(
				(row) => row.textContent,
			);
		expect(names()).toEqual(["Beta", "Zebra", "Alpha", "Zulu"]);
		click(
			container.querySelector('button[aria-label="Add Alpha to favorites"]')!,
		);
		await flush();
		expect(names()).toEqual(["Alpha", "Beta", "Zebra", "Zulu"]);
		items = [
			...items,
			{
				workspaceId: "plain-a",
				favorite: true,
				lastOpenedAt: null,
				updatedAt: "2026-10-24",
			},
		];
		await act(async () => resolveSave());
		await flush();
		click(
			container.querySelector(
				'button[aria-label="Remove Beta from favorites"]',
			)!,
		);
		await flush();
		expect(names()).toEqual(["Alpha", "Zebra", "Beta", "Zulu"]);
		await act(async () => rejectSave(new Error("Save failed")));
		await flush();
		expect(names()).toEqual(["Alpha", "Beta", "Zebra", "Zulu"]);
		expect(container.textContent).toContain("Could not save favorite");
		act(() => root.unmount());
	});

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

	it("asks the server, so a search reaches workspaces beyond the loaded page", async () => {
		// The loaded page holds no match; only a server-side search finds it.
		api.workspaces.list.mockImplementation(
			async (input: { status?: string; search?: string }) =>
				input.search
					? {
							items: [
								workspace({
									id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
									name: "Reddit Intelligence",
									description: null,
								}),
							],
							truncated: false,
						}
					: {
							items: [
								workspace(),
								workspace({
									id: SECOND_WORKSPACE_ID,
									name: "Support Desk",
									description: "Customer triage",
								}),
							],
							truncated: true,
						},
		);
		const { container, root } = await renderPage();
		const search = container.querySelector(
			'input[aria-label="Search workspaces"]',
		);
		if (!(search instanceof HTMLInputElement))
			throw new Error("search missing");
		setFieldValue(search, "Reddit");
		// Past the debounce so the keyed search request fires.
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 300));
		});
		await flush();
		expect(api.workspaces.list).toHaveBeenCalledWith(
			{ status: "active", limit: 100, search: "Reddit" },
			expect.anything(),
		);
		expect(container.textContent).toContain("Reddit Intelligence");
		expect(container.textContent).not.toContain("Weekly revenue reporting");
		expect(container.textContent).not.toContain("No workspaces match");
		act(() => root.unmount());
	});

	it("reports an answered no-match without losing the search box", async () => {
		api.workspaces.list.mockImplementation(
			async (input: { status?: string; search?: string }) =>
				input.search
					? { items: [], truncated: false }
					: { items: [workspace()], truncated: false },
		);
		const { container, root } = await renderPage();
		const search = container.querySelector(
			'input[aria-label="Search workspaces"]',
		);
		if (!(search instanceof HTMLInputElement))
			throw new Error("search missing");
		setFieldValue(search, "nothing matches");
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 300));
		});
		await flush();
		expect(container.textContent).toContain("No workspaces match");
		expect(container.textContent).not.toContain("No workspaces yet");
		expect(
			container.querySelector('input[aria-label="Search workspaces"]'),
		).not.toBeNull();
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

function button(container: HTMLElement, name: string) {
	const found = Array.from(container.querySelectorAll("button")).find(
		(element) =>
			element.getAttribute("aria-label") === name ||
			element.textContent?.trim() === name,
	);
	if (!found) throw new Error(`Missing button: ${name}`);
	return found;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("Workspace library recovery", () => {
	it("keeps navigation usable while preferences are pending and unknown", async () => {
		const pending = deferred<{ items: [] }>();
		api.workspacePreferences.list.mockReturnValue(pending.promise);
		const { container, root } = await renderPage();
		expect(container.textContent).toContain("Loading favorites");
		expect(
			container.querySelector(`a[href="/workspace/${WORKSPACE_ID}"]`),
		).not.toBeNull();
		expect(
			button(container, "Favorites unavailable for Revenue Ops").disabled,
		).toBe(true);
		expect(
			container.querySelector('[aria-label="Add Revenue Ops to favorites"]'),
		).toBeNull();
		await act(async () => pending.resolve({ items: [] }));
		await flush();
		expect(button(container, "Add Revenue Ops to favorites").disabled).toBe(
			false,
		);
		act(() => root.unmount());
	});

	it("retries only failed preferences without replaying any write", async () => {
		api.workspacePreferences.list.mockRejectedValue(
			new Error("preferences offline"),
		);
		const { container, root } = await renderPage();
		expect(container.textContent).toContain("Favorites are unavailable");
		expect(
			button(container, "Favorites unavailable for Revenue Ops").disabled,
		).toBe(true);
		api.workspacePreferences.list.mockResolvedValue({ items: [] });
		const discoveryCalls = api.workspaces.list.mock.calls.length;
		click(button(container, "Retry favorites"));
		await flush();
		expect(api.workspaces.list).toHaveBeenCalledTimes(discoveryCalls);
		expect(button(container, "Add Revenue Ops to favorites").disabled).toBe(
			false,
		);
		expect(api.workspacePreferences.setFavorite).not.toHaveBeenCalled();
		act(() => root.unmount());
	});

	it("retains cached active rows on failed refresh and retries the exact list", async () => {
		const { activeWorkspacesQueryOptions } =
			await import("@/lib/os-query-options");
		const { container, root, queryClient } = await renderPage();
		api.workspaces.list.mockRejectedValue(new Error("discovery offline"));
		await act(async () => {
			await queryClient.refetchQueries({
				...activeWorkspacesQueryOptions(),
				exact: true,
			});
		});
		await flush();
		expect(container.textContent).toContain("Workspaces could not refresh");
		expect(container.textContent).toContain(
			"Showing previously loaded workspaces",
		);
		expect(
			container.querySelector(`a[href="/workspace/${WORKSPACE_ID}"]`),
		).not.toBeNull();
		setFieldValue(container.querySelector("input")!, "missing");
		expect(container.textContent).not.toContain("No loaded workspaces match");
		const preferenceCalls = api.workspacePreferences.list.mock.calls.length;
		api.workspaces.list.mockResolvedValue({ items: [], truncated: false });
		click(button(container, "Retry workspaces"));
		await flush();
		expect(container.textContent).toContain("No workspaces yet");
		expect(api.workspacePreferences.list).toHaveBeenCalledTimes(
			preferenceCalls,
		);
		act(() => root.unmount());
	});

	it("does not turn cached empty data into a current empty claim after refresh fails", async () => {
		const { activeWorkspacesQueryOptions } =
			await import("@/lib/os-query-options");
		api.workspaces.list.mockResolvedValue({ items: [], truncated: false });
		const { container, root, queryClient } = await renderPage();
		api.workspaces.list.mockRejectedValue(new Error("offline"));
		await act(async () => {
			await queryClient.refetchQueries({
				...activeWorkspacesQueryOptions(),
				exact: true,
			});
		});
		await flush();
		expect(container.textContent).not.toContain("No workspaces yet");
		act(() => root.unmount());
	});

	it("retries an unavailable archive, then retains its cached rows on later failure", async () => {
		const { archivedWorkspacesQueryOptions } =
			await import("@/lib/os-query-options");
		api.workspaces.list.mockImplementation(
			async (input: { status?: string }) => {
				if (input.status === "archived") throw new Error("archive offline");
				return { items: [workspace()], truncated: false };
			},
		);
		const { container, root, queryClient } = await renderPage();
		click(button(container, "Archived"));
		await flush();
		expect(container.textContent).toContain(
			"Archived workspaces are unavailable",
		);
		expect(container.textContent).not.toContain("No archived workspaces");
		api.workspaces.list.mockResolvedValue({
			items: [workspace({ status: "archived" })],
			truncated: true,
		});
		click(button(container, "Retry archived workspaces"));
		await flush();
		expect(container.textContent).toContain("Revenue Ops");
		expect(api.workspaces.list.mock.calls.at(-1)?.[0]).toEqual({
			status: "archived",
			limit: 100,
		});
		api.workspaces.list.mockRejectedValue(new Error("archive offline again"));
		await act(async () => {
			await queryClient.refetchQueries({
				...archivedWorkspacesQueryOptions(),
				exact: true,
			});
		});
		await flush();
		expect(container.textContent).toContain(
			"Archived workspaces could not refresh",
		);
		expect(container.textContent).toContain("Revenue Ops");
		expect(container.textContent).toContain(
			"Showing the first 1 archived workspaces",
		);
		act(() => root.unmount());
	});

	it("prevents duplicate favorite clicks and distinguishes write failure", async () => {
		const pending = deferred<unknown>();
		api.workspacePreferences.setFavorite.mockReturnValue(pending.promise);
		const { container, root } = await renderPage();
		const toggle = button(container, "Add Support Desk to favorites");
		click(toggle);
		await flush();
		const pendingToggle = button(
			container,
			"Remove Support Desk from favorites",
		);
		expect(pendingToggle.disabled).toBe(true);
		click(pendingToggle);
		expect(api.workspacePreferences.setFavorite).toHaveBeenCalledTimes(1);
		expect(container.textContent).toContain("Saving favorite");
		act(() => root.unmount());
		api.workspacePreferences.setFavorite.mockRejectedValue(
			new Error("write refused"),
		);
		const failed = await renderPage();
		click(button(failed.container, "Add Support Desk to favorites"));
		await flush();
		expect(failed.container.textContent).toContain("Could not save favorite");
		expect(failed.container.textContent).toContain("write refused");
		act(() => failed.root.unmount());
	});

	it.each(["invalidateQueries", "setQueryData"] as const)(
		"keeps a confirmed favorite separate from rejected %s",
		async (method) => {
			const { container, root, queryClient } = await renderPage();
			if (method === "invalidateQueries")
				vi.spyOn(queryClient, method).mockRejectedValue(
					new Error("refresh rejected"),
				);
			else {
				const setQueryData = queryClient.setQueryData.bind(queryClient);
				vi.spyOn(queryClient, method)
					.mockImplementationOnce(setQueryData)
					.mockImplementation(() => {
						throw new Error("cache rejected");
					});
			}
			click(button(container, "Add Support Desk to favorites"));
			await flush();
			expect(container.textContent).toContain("Favorite saved");
			expect(container.textContent).toContain("could not refresh");
			expect(container.textContent).not.toContain("Could not save favorite");
			expect(
				button(container, "Favorites unavailable for Support Desk").disabled,
			).toBe(true);
			click(button(container, "Retry favorites"));
			await flush();
			expect(api.workspacePreferences.setFavorite).toHaveBeenCalledTimes(1);
			act(() => root.unmount());
		},
	);

	it.each(["invalidateQueries", "setQueryData"] as const)(
		"keeps confirmed restore visible after rejected %s without offering replay",
		async (method) => {
			api.workspaces.list.mockResolvedValue({
				items: [workspace({ status: "archived" })],
				truncated: false,
			});
			api.workspaces.restore.mockResolvedValue({ workspace: workspace() });
			const { container, root, queryClient } = await renderPage();
			click(button(container, "Archived"));
			await flush();
			if (method === "invalidateQueries")
				vi.spyOn(queryClient, method).mockRejectedValue(
					new Error("refresh rejected"),
				);
			else
				vi.spyOn(queryClient, method).mockImplementation(() => {
					throw new Error("cache rejected");
				});
			click(button(container, "Restore Revenue Ops"));
			await flush();
			expect(container.textContent).toContain("Workspace restored");
			expect(container.textContent).toContain("could not refresh");
			expect(container.textContent).not.toContain(
				"Could not restore the workspace",
			);
			expect(
				container.querySelector('[aria-label="Restore Revenue Ops"]'),
			).toBeNull();
			click(button(container, "Retry archived workspaces"));
			await flush();
			expect(api.workspaces.restore).toHaveBeenCalledTimes(1);
			expect(
				container.querySelector('[aria-label="Restore Revenue Ops"]'),
			).toBeNull();
			click(button(container, "Active"));
			click(button(container, "Archived"));
			await flush();
			expect(
				container.querySelector('[aria-label="Restore Revenue Ops"]'),
			).toBeNull();
			act(() => root.unmount());
		},
	);
});

it("retries initial active discovery without fetching preferences or mutating", async () => {
	api.workspaces.list.mockRejectedValue(new Error("active offline"));
	const { container, root } = await renderPage();
	expect(container.textContent).toContain("Workspaces are unavailable");
	expect(container.textContent).not.toContain("No workspaces yet");
	const preferenceCalls = api.workspacePreferences.list.mock.calls.length;
	api.workspaces.list.mockResolvedValue({
		items: [workspace()],
		truncated: false,
	});
	click(button(container, "Retry workspaces"));
	await flush();
	expect(api.workspaces.list.mock.calls.at(-1)?.[0]).toEqual({
		status: "active",
		limit: 100,
	});
	expect(api.workspacePreferences.list).toHaveBeenCalledTimes(preferenceCalls);
	expect(api.workspacePreferences.setFavorite).not.toHaveBeenCalled();
	act(() => root.unmount());
});

it("makes cached favorites unknown after their refresh fails", async () => {
	const { workspacePreferencesQueryOptions } =
		await import("@/lib/os-query-options");
	const { container, root, queryClient } = await renderPage();
	expect(
		button(container, "Remove Revenue Ops from favorites").getAttribute(
			"aria-pressed",
		),
	).toBe("true");
	api.workspacePreferences.list.mockRejectedValue(
		new Error("preferences offline"),
	);
	await act(async () => {
		await queryClient.refetchQueries({
			...workspacePreferencesQueryOptions(),
			exact: true,
		});
	});
	await flush();
	const unknown = button(container, "Favorites unavailable for Revenue Ops");
	expect(unknown.disabled).toBe(true);
	expect(unknown.hasAttribute("aria-pressed")).toBe(false);
	expect(
		container.querySelector(`a[href="/workspace/${WORKSPACE_ID}"]`),
	).not.toBeNull();
	act(() => root.unmount());
});

it("fences duplicate restores and reports a rejected write separately", async () => {
	let reject!: (error: Error) => void;
	api.workspaces.restore.mockReturnValue(
		new Promise((_resolve, fail) => {
			reject = fail;
		}),
	);
	api.workspaces.list.mockResolvedValue({
		items: [workspace({ status: "archived" })],
		truncated: false,
	});
	const { container, root } = await renderPage();
	click(button(container, "Archived"));
	await flush();
	click(button(container, "Restore Revenue Ops"));
	click(button(container, "Restore Revenue Ops"));
	await flush();
	expect(api.workspaces.restore).toHaveBeenCalledTimes(1);
	expect(button(container, "Restore Revenue Ops").disabled).toBe(true);
	await act(async () => reject(new Error("restore refused")));
	await flush();
	expect(container.textContent).toContain("Could not restore the workspace");
	expect(container.textContent).toContain("restore refused");
	expect(container.textContent).not.toContain("Workspace restored");
	expect(button(container, "Restore Revenue Ops").disabled).toBe(false);
	act(() => root.unmount());
});

it.each(["active", "archived"] as const)(
	"bounds an empty %s page when the response is truncated",
	async (view) => {
		api.workspaces.list.mockResolvedValue({ items: [], truncated: true });
		const { container, root } = await renderPage();
		if (view === "archived") {
			click(button(container, "Archived"));
			await flush();
		}
		expect(container.textContent).toContain("in this loaded page");
		expect(container.textContent).toContain("beyond this page");
		act(() => root.unmount());
	},
);

it("shows a newer archive after a confirmed restore without replaying the write", async () => {
	let archivedWorkspace = workspace({ status: "archived" });
	api.workspaces.list.mockImplementation(
		async (input: { status?: string }) => ({
			items: input.status === "archived" ? [archivedWorkspace] : [workspace()],
			truncated: false,
		}),
	);
	api.workspaces.restore.mockResolvedValue({
		workspace: workspace({ updatedAt: "2026-10-21T12:00:00.000Z" }),
	});
	const { container, root, queryClient } = await renderPage();
	click(button(container, "Archived"));
	await flush();
	vi.spyOn(queryClient, "invalidateQueries").mockRejectedValue(
		new Error("refresh rejected"),
	);
	click(button(container, "Restore Revenue Ops"));
	await flush();
	expect(
		container.querySelector('[aria-label="Restore Revenue Ops"]'),
	).toBeNull();
	archivedWorkspace = workspace({
		status: "archived",
		updatedAt: "2026-10-21T12:01:00.000Z",
	});
	click(button(container, "Retry archived workspaces"));
	await flush();
	expect(button(container, "Restore Revenue Ops").disabled).toBe(false);
	expect(api.workspaces.restore).toHaveBeenCalledTimes(1);
	act(() => root.unmount());
});
