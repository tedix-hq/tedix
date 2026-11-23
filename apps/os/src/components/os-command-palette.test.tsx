import { SquaresFour } from "@phosphor-icons/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, StrictMode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import { WORK_VIEWS } from "@/lib/work-views";
import {
	commandScore,
	createCommands,
	highlightParts,
	matchesCommand,
	OsCommandPalette,
	pageCommands,
	rankCommands,
	workViewCommands,
} from "./os-command-palette";
import {
	appListQueryOptions,
	commandPaletteWorkspacesQueryOptions,
} from "@/lib/os-query-options";

const reads = vi.hoisted(() => ({
	workspaces: vi.fn(async (_limit: number): Promise<unknown> => ({
		items: [],
	})),
	outputs: vi.fn(async (_limit: number): Promise<unknown> => ({ items: [] })),
	apps: vi.fn(async (_limit: number): Promise<unknown> => ({ data: [] })),
	skills: vi.fn(async (_limit: number): Promise<unknown> => ({ entries: [] })),
	runs: vi.fn(async (_limit: number): Promise<unknown> => ({ runs: [] })),
	workApps: vi.fn(async (): Promise<unknown> => ({ items: [] })),
	preferences: vi.fn(async (): Promise<unknown> => ({ items: [] })),
	activeWorkspaces: vi.fn(async (): Promise<unknown> => ({ items: [] })),
	navigate: vi.fn(),
	pathname: "/work",
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	useNavigate: () => reads.navigate,
	useLocation: () => reads.pathname,
}));

// Keep contract-derived keys and real Query observers; replace only the reads.
vi.mock("@/lib/os-query-options", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("@/lib/os-query-options")>();
	return {
		...original,
		commandPaletteWorkspacesQueryOptions: (limit: number) => ({
			...original.commandPaletteWorkspacesQueryOptions(limit),
			queryFn: () => reads.workspaces(limit),
		}),
		commandPaletteOutputLibraryQueryOptions: (limit: number) => ({
			...original.commandPaletteOutputLibraryQueryOptions(limit),
			queryFn: () => reads.outputs(limit),
		}),
		appListQueryOptions: (limit: number) => ({
			...original.appListQueryOptions(limit),
			queryFn: () => reads.apps(limit),
		}),
		skillCatalogQueryOptions: (limit: number) => ({
			...original.skillCatalogQueryOptions(limit),
			queryFn: () => reads.skills(limit),
		}),
		skillRunHistoryQueryOptions: (limit: number) => ({
			...original.skillRunHistoryQueryOptions(limit),
			queryFn: () => reads.runs(limit),
		}),
		workAppsQueryOptions: () => ({
			...original.workAppsQueryOptions(),
			queryFn: () => reads.workApps(),
		}),
		workspacePreferencesQueryOptions: () => ({
			...original.workspacePreferencesQueryOptions(),
			queryFn: () => reads.preferences(),
		}),
		activeWorkspacesQueryOptions: () => ({
			...original.activeWorkspacesQueryOptions(),
			queryFn: () => reads.activeWorkspaces(),
		}),
	};
});

const command = {
	id: "canvas",
	title: "Canvas",
	description: "Workspaces, Apps, layouts, and previews",
	icon: SquaresFour,
	run: () => undefined,
};

describe("OS command palette matching", () => {
	it("matches a word inside a workspace title and partial later words", () => {
		const workspace = {
			...command,
			title: "Tedix Books Reference",
			description: "Workspace",
		};
		expect(matchesCommand(workspace, "book")).toBe(true);
		expect(matchesCommand(workspace, "BOOKS reference")).toBe(true);
		expect(matchesCommand(workspace, "tedix missing")).toBe(false);
	});

	it("matches title and description tokens without case sensitivity", () => {
		expect(matchesCommand(command, "canvas")).toBe(true);
		expect(matchesCommand(command, "APP previews")).toBe(true);
	});

	it("requires every search token", () => {
		expect(matchesCommand(command, "workspace policy")).toBe(false);
		expect(matchesCommand(command, "   ")).toBe(true);
	});
});

describe("create commands", () => {
	it("offers a workspace, a doc, a sheet and slides and starts the one chosen", () => {
		const start = vi.fn();
		const commands = createCommands(start, false);
		expect(commands.map((item) => item.title)).toEqual([
			"New workspace",
			"New doc",
			"New sheet",
			"New slides",
		]);
		commands[2]!.run();
		expect(start).toHaveBeenCalledWith("sheet");
		expect(matchesCommand(commands[1]!, "new doc")).toBe(true);
		expect(matchesCommand(commands[3]!, "create slides")).toBe(true);
	});

	it("says where a new file goes", () => {
		expect(createCommands(() => {}, true)[1]!.description).toContain(
			"in this workspace",
		);
		expect(createCommands(() => {}, false)[1]!.description).toContain(
			"in a workspace you choose",
		);
	});
});

describe("ordering", () => {
	const named = (id: string, title: string, description = "Workspace") => ({
		...command,
		id,
		title,
		description,
		workspace: { id, name: title, visibility: "team" },
	});

	it("puts a whole-name match before a start, a word start, a middle and a description match", () => {
		const ranked = rankCommands(
			[
				named("description", "Finance", "Workspace · plan the launch"),
				named("middle", "Replan"),
				named("word", "Launch plan"),
				named("start", "Planning"),
				named("exact", "Plan"),
				named("none", "Budget"),
			],
			"plan",
		);
		expect(ranked.map((item) => item.id)).toEqual([
			"exact",
			"start",
			"word",
			"middle",
			"description",
		]);
		expect(commandScore(named("none", "Budget"), "plan")).toBe(0);
	});

	it("orders equally good workspaces by when they were last opened", () => {
		const ranked = rankCommands(
			[
				named("never", "Plan north"),
				named("older", "Plan south"),
				named("newest", "Plan east"),
			],
			"plan",
			new Map([
				["older", "2026-11-01T10:00:00.000Z"],
				["newest", "2026-11-17T10:00:00.000Z"],
			]),
		);
		expect(ranked.map((item) => item.id)).toEqual(["newest", "older", "never"]);
	});

	it("keeps the given order when nothing tells results apart", () => {
		const ranked = rankCommands(
			[named("b", "Plan b"), named("a", "Plan a")],
			"plan",
		);
		expect(ranked.map((item) => item.id)).toEqual(["b", "a"]);
	});
});

describe("highlight", () => {
	it("marks every part the query matched and nothing else", () => {
		expect(highlightParts("Tedix Books Reference", "book ref")).toEqual([
			{ text: "Tedix ", match: false },
			{ text: "Book", match: true },
			{ text: "s ", match: false },
			{ text: "Ref", match: true },
			{ text: "erence", match: false },
		]);
	});

	it("joins overlapping matches and leaves text alone without a query", () => {
		expect(highlightParts("Planning", "plan lann")).toEqual([
			{ text: "Plann", match: true },
			{ text: "ing", match: false },
		]);
		expect(highlightParts("Planning", " ")).toEqual([
			{ text: "Planning", match: false },
		]);
	});
});

describe("Work view commands", () => {
	it("offers a Go to command for every registered Work view", () => {
		const open = vi.fn();
		const commands = workViewCommands(open);
		expect(commands.map((command) => command.title)).toEqual(
			WORK_VIEWS.map((view) => `Go to ${view.label}`),
		);
		for (const [index, view] of WORK_VIEWS.entries()) {
			expect(commands[index]!.description).toContain(view.description);
			commands[index]!.run();
			expect(open).toHaveBeenLastCalledWith(view);
		}
		expect(open).toHaveBeenCalledTimes(WORK_VIEWS.length);
	});

	it("offers only the views it is given", () => {
		const views = WORK_VIEWS.filter((view) => !view.requiresApp);
		expect(
			workViewCommands(() => undefined, views).map((command) => command.title),
		).toEqual(views.map((view) => `Go to ${view.label}`));
	});

	it("is found by the page name and by what the page shows", () => {
		const commands = workViewCommands(() => undefined);
		expect(commands.filter((c) => matchesCommand(c, "approvals"))).toHaveLength(
			1,
		);
		expect(commands.some((c) => matchesCommand(c, "go to projects"))).toBe(
			true,
		);
		expect(commands.some((c) => matchesCommand(c, "budgets"))).toBe(true);
	});
});

describe("page commands", () => {
	it("finds admin and account pages by all search tokens and navigates", () => {
		const open = vi.fn();
		const commands = pageCommands(open, "/work");
		for (const [query, path, id] of [
			[
				"go to organization settings",
				"/admin/organization",
				"admin-organization",
			],
			["api keys", "/admin/api-keys", "admin-api-keys"],
			["account profile", "/account/profile", "account-profile"],
		]) {
			const command = commands.find((item) => item.id === `page-${id}`);
			expect(command).toBeDefined();
			expect(matchesCommand(command!, query!)).toBe(true);
			command!.run();
			expect(open).toHaveBeenLastCalledWith(path);
		}
	});
	it("offers every tedi tab using the current tedi identity", () => {
		const open = vi.fn();
		const commands = pageCommands(open, "/team/tedi-1/memory");
		for (const tab of [
			"authority",
			"learning",
			"mailbox",
			"memory",
			"settings",
			"telemetry",
		]) {
			const command = commands.find((item) => item.id === `page-tedi-${tab}`);
			expect(command).toBeDefined();
			expect(matchesCommand(command!, `team tedi ${tab}`)).toBe(true);
			command!.run();
			expect(open).toHaveBeenLastCalledWith(`/team/tedi-1/${tab}`);
		}
	});
	it("never navigates to unresolved dynamic placeholders or mistakes new for a tedi", () => {
		for (const path of ["/work", "/team/new"]) {
			const open = vi.fn();
			const commands = pageCommands(open, path);
			expect(
				commands.some((command) => command.id.startsWith("page-tedi-")),
			).toBe(false);
			commands.forEach((command) => command.run());
			expect(
				open.mock.calls.every(([destination]) => !destination.includes("$")),
			).toBe(true);
		}
	});
});

describe("mounted palette resource states", () => {
	let root: Root;
	let host: HTMLDivElement;
	let client: QueryClient;

	beforeEach(() => {
		Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
		reads.workspaces.mockReset().mockResolvedValue({ items: [] });
		reads.outputs.mockReset().mockResolvedValue({ items: [] });
		reads.apps.mockReset().mockResolvedValue({ data: [] });
		reads.skills.mockReset().mockResolvedValue({ entries: [] });
		reads.runs.mockReset().mockResolvedValue({ runs: [] });
		reads.workApps.mockReset().mockResolvedValue({ items: [] });
		reads.preferences.mockReset().mockResolvedValue({ items: [] });
		reads.activeWorkspaces.mockReset().mockResolvedValue({ items: [] });
		reads.navigate.mockReset();
		reads.pathname = "/work";
		client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		client.clear();
		host.remove();
	});

	async function mount() {
		function Fixture() {
			const [open, setOpen] = useState(false);
			return (
				<QueryClientProvider client={client}>
					<button type="button" onClick={() => setOpen(true)}>
						Open palette
					</button>
					{open ? (
						<OsCommandPalette open={open} onOpenChange={setOpen} />
					) : null}
				</QueryClientProvider>
			);
		}
		await act(async () =>
			root.render(
				<StrictMode>
					<Fixture />
				</StrictMode>,
			),
		);
	}

	function button(name: string) {
		const found = [...document.querySelectorAll("button")].find(
			(node) => node.textContent === name,
		);
		expect(found, name).toBeDefined();
		return found!;
	}

	async function openPalette() {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 100));
		});
		await act(async () => {
			button("Open palette").focus();
			button("Open palette").click();
		});
	}

	async function search(value: string) {
		const input = document.querySelector<HTMLInputElement>("input")!;
		await act(async () => {
			Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)!.set!.call(input, value);
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
	}

	async function settled() {
		await act(async () => {
			await vi.waitFor(() => expect(client.isFetching()).toBe(0));
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
	}

	function options() {
		return [...document.querySelectorAll<HTMLElement>("[role=option]")];
	}
	function option(text: string) {
		const found = options().find((node) => node.textContent?.includes(text));
		expect(found, text).toBeDefined();
		return found!;
	}
	const workspaceRows = [
		{ id: "alpha", name: "Alpha plans", visibility: "team" },
		{ id: "beta", name: "Beta plans", visibility: "team" },
		{ id: "gamma", name: "Gamma plans", visibility: "team" },
	];
	const openedRows = [
		{ workspaceId: "beta", lastOpenedAt: "2026-11-10T10:00:00.000Z" },
		{ workspaceId: "gamma", lastOpenedAt: "2026-11-17T10:00:00.000Z" },
		{ workspaceId: "alpha", lastOpenedAt: null },
	];
	async function pause() {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 50));
		});
	}

	it("names the quick search dialog for screen readers", async () => {
		await mount();
		await openPalette();
		const dialog = document.querySelector('[role="dialog"]');
		const labelId = dialog?.getAttribute("aria-labelledby");
		expect(labelId && document.getElementById(labelId)?.textContent).toBe(
			"Quick search",
		);
	});

	it("lists recently opened workspaces first, newest first, before anything is typed", async () => {
		reads.workspaces.mockResolvedValue({ items: workspaceRows });
		reads.preferences.mockResolvedValue({ items: openedRows });
		await mount();
		await openPalette();
		await settled();
		const names = options().map((node) => node.textContent ?? "");
		expect(names[0]).toContain("Gamma plans");
		expect(names[1]).toContain("Beta plans");
		expect(names[2]).toContain("New workspace");
		expect(document.body.textContent).toContain("Recent workspaces");
		// A recent workspace is listed once; the rest stay under Workspaces.
		expect(names.filter((name) => name.includes("Gamma plans"))).toHaveLength(
			1,
		);
		expect(
			names.findIndex((name) => name.includes("Alpha plans")),
		).toBeGreaterThan(2);
	});

	it("orders equally good workspace matches by recency and highlights what matched", async () => {
		reads.workspaces.mockResolvedValue({ items: workspaceRows });
		reads.preferences.mockResolvedValue({ items: openedRows });
		await mount();
		await openPalette();
		await settled();
		await search("plans");
		const names = options().map((node) => node.textContent ?? "");
		expect(
			names
				.slice(0, 3)
				.map((name) => name.match(/(Alpha|Beta|Gamma) plans/)?.[1]),
		).toEqual(["Gamma", "Beta", "Alpha"]);
		expect(document.body.textContent).not.toContain("Recent workspaces");
		const marks = [...option("Gamma plans").querySelectorAll("mark")].map(
			(node) => node.textContent,
		);
		expect(marks).toEqual(["plans"]);
	});

	it("still lists workspaces when their recency cannot be read", async () => {
		reads.workspaces.mockResolvedValue({ items: workspaceRows });
		reads.preferences.mockRejectedValue(new Error("offline"));
		await mount();
		await openPalette();
		await settled();
		expect(document.body.textContent).not.toContain("unavailable");
		expect(document.body.textContent).not.toContain("Recent workspaces");
		expect(option("Alpha plans")).toBeDefined();
	});

	it("opens the create workspace dialog from New workspace and closes with it", async () => {
		await mount();
		await openPalette();
		await settled();
		await search("new workspace");
		await act(async () => option("New workspace").click());
		await pause();
		expect(document.querySelector("[role=dialog]")?.textContent).toContain(
			"Create workspace",
		);
		expect(document.querySelector("[role=option]")).toBeNull();
		expect(reads.navigate).not.toHaveBeenCalled();
		await act(async () => button("Cancel").click());
		await pause();
		expect(document.querySelector("[role=dialog]")).toBeNull();
		expect(document.querySelector("input")).toBeNull();
	});

	it("creates a file in the workspace on screen without asking where", async () => {
		reads.pathname = "/workspace/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
		await mount();
		await openPalette();
		await settled();
		expect(option("New sheet").textContent).toContain("in this workspace");
		await act(async () => option("New sheet").click());
		await pause();
		const dialog = document.querySelector("[role=dialog]")!;
		expect(dialog.textContent).toContain("New Sheet");
		expect(dialog.textContent).not.toContain("Choose a workspace");
		expect(button("Create Sheet").disabled).toBe(false);
		expect(reads.activeWorkspaces).not.toHaveBeenCalled();
	});

	it("asks which workspace a new file goes in when none is on screen", async () => {
		reads.activeWorkspaces.mockResolvedValue({
			items: [
				{ id: "alpha", name: "Alpha plans" },
				{ id: "beta", name: "Beta plans" },
			],
		});
		await mount();
		await openPalette();
		await settled();
		await search("new doc");
		await act(async () => options()[0]!.click());
		await settled();
		const dialog = document.querySelector("[role=dialog]")!;
		expect(dialog.textContent).toContain("New Doc");
		expect(dialog.textContent).toContain("Choose a workspace");
		expect(button("Create Doc").disabled).toBe(true);
		expect(reads.activeWorkspaces).toHaveBeenCalled();
	});

	it("does not fetch even when the closed palette remains mounted", async () => {
		await act(async () =>
			root.render(
				<QueryClientProvider client={client}>
					<OsCommandPalette open={false} onOpenChange={() => undefined} />
				</QueryClientProvider>,
			),
		);
		expect(client.isFetching()).toBe(0);
		for (const read of [
			reads.workspaces,
			reads.outputs,
			reads.apps,
			reads.skills,
			reads.runs,
		])
			expect(read).not.toHaveBeenCalled();
	});

	it("surfaces a failed domain while another result stays navigable and retries only failed reads", async () => {
		reads.apps.mockRejectedValue(new Error("offline"));
		reads.workspaces.mockResolvedValue({
			items: [
				{ id: "pine-studio", name: "Pine Studio", visibility: "private" },
			],
		});
		await mount();
		for (const read of [
			reads.workspaces,
			reads.outputs,
			reads.apps,
			reads.skills,
			reads.runs,
		])
			expect(read).not.toHaveBeenCalled();
		await openPalette();
		await settled();
		expect(document.body.textContent).toContain("Some resources unavailable");
		expect(document.body.textContent).toContain("Apps");
		expect(document.body.textContent).toContain("Go to");
		expect(document.body.textContent).toContain("Pine Studio");
		await search("nothing-matches-this");
		expect(document.body.textContent).not.toContain(
			"No matching pages or resources",
		);
		expect(document.body.textContent).toContain(
			"No matches in available pages or resources",
		);
		reads.apps.mockResolvedValue({ data: [] });
		await act(async () => button("Retry unavailable resources").click());
		await settled();
		expect(document.body.textContent).not.toContain(
			"Some resources unavailable",
		);
		expect(reads.apps).toHaveBeenCalledTimes(2);
		for (const read of [reads.workspaces, reads.outputs, reads.skills])
			expect(read).toHaveBeenCalledExactlyOnceWith(12);
		expect(reads.runs).toHaveBeenCalledExactlyOnceWith(8);
		await search("Pine Studio");
		const item = [
			...document.querySelectorAll<HTMLElement>("[role=option]"),
		].find((node) => node.textContent?.includes("Pine Studio"));
		expect(item).toBeDefined();
		await act(async () => item!.click());
		expect(reads.navigate).toHaveBeenCalledWith({
			to: "/workspace/$workspaceId",
			params: { workspaceId: "pine-studio" },
		});
	});

	it("offers an app-backed Work view only once the organization has the app", async () => {
		await mount();
		await openPalette();
		await settled();
		expect(document.body.textContent).toContain("Go to Capacity");
		expect(document.body.textContent).not.toContain("Go to Outbound review");
		expect(document.body.textContent).not.toContain("Go to Office");

		reads.workApps.mockResolvedValue({
			items: [
				{
					gadget: { id: "outbound-app" },
					currentRevision: {
						manifest: { entry: "tedix:app/outbound-review" },
					},
				},
			],
		});
		await act(async () => client.invalidateQueries());
		await settled();
		expect(document.body.textContent).toContain("Go to Outbound review");
		expect(document.body.textContent).not.toContain("Go to Office");
	});

	it("distinguishes cold loading from empty success without hiding static navigation", async () => {
		let resolve!: (value: unknown) => void;
		reads.apps.mockImplementation(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		await mount();
		await openPalette();
		expect(
			document.querySelector('[aria-label="Loading resources"]'),
		).not.toBeNull();
		expect(document.body.textContent).toContain("Go to Goals");
		await search("nothing-matches-this");
		expect(document.body.textContent).not.toContain(
			"No matching pages or resources",
		);
		await act(async () => resolve({ data: [] }));
		await settled();
		expect(
			document.querySelector('[aria-label="Loading resources"]'),
		).toBeNull();
		expect(document.body.textContent).toContain(
			"No matching pages or resources",
		);
		expect(
			document.querySelector('[aria-label="Resource availability"]'),
		).toBeNull();
	});

	it("keeps cached results after a failed refresh and prevents concurrent retries", async () => {
		const options = appListQueryOptions(12);
		client.setQueryData(options.queryKey, {
			data: [
				{
					id: "11111111-1111-4111-8111-111111111111",
					name: "Pine Notes",
					slug: "pine-notes",
					domain: null,
					description: null,
					logoUrl: null,
					visibility: "private",
					discoveryStatus: null,
					customMcpDomain: null,
					appStoreStatus: null,
					createdAt: null,
					updatedAt: null,
				},
			],
			pagination: { limit: 12, offset: 0, total: 1, hasMore: false },
		});
		reads.apps.mockRejectedValue(new Error("refresh failed"));
		await mount();
		await openPalette();
		await act(async () => {
			await client.invalidateQueries({ queryKey: options.queryKey });
		});
		await settled();
		expect(document.body.textContent).toContain(
			"Saved results may be out of date",
		);
		expect(document.body.textContent).toContain("Pine Notes");
		const beforeRetry = reads.apps.mock.calls.length;
		let resolve!: (value: unknown) => void;
		reads.apps.mockImplementation(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		const retry = button("Retry unavailable resources");
		await act(async () => retry.click());
		expect(retry.disabled).toBe(true);
		expect(document.body.textContent).toContain("Retrying resources…");
		await act(async () => retry.click());
		expect(reads.apps).toHaveBeenCalledTimes(beforeRetry + 1);
		expect(document.body.textContent).toContain("Pine Notes");
		await act(async () =>
			resolve({
				data: [
					{ id: "pine-app", name: "Pine Notes refreshed", slug: "pine-notes" },
				],
			}),
		);
		await settled();
		expect(document.body.textContent).toContain("Pine Notes refreshed");
		expect(
			document.querySelector('[aria-label="Resource availability"]'),
		).toBeNull();
		expect(reads.workspaces).toHaveBeenCalledExactlyOnceWith(12);
	});

	it("shows all-read failure and leaves static pages available after an unsuccessful retry", async () => {
		for (const read of [
			reads.workspaces,
			reads.outputs,
			reads.apps,
			reads.skills,
			reads.runs,
		])
			read.mockRejectedValue(new Error("offline"));
		await mount();
		await openPalette();
		await settled();
		const status = document.querySelector(
			'[aria-label="Resource availability"]',
		);
		expect(status?.getAttribute("role")).toBe("status");
		expect(status?.textContent).toContain("Resources unavailable");
		expect(status?.textContent).toContain("Workspaces");
		expect(status?.textContent).toContain("Recent runs");
		expect(document.body.textContent).toContain("Go to Goals");
		await act(async () => button("Retry unavailable resources").click());
		await settled();
		expect(button("Retry unavailable resources").disabled).toBe(false);
		for (const read of [
			reads.workspaces,
			reads.outputs,
			reads.apps,
			reads.skills,
			reads.runs,
		])
			expect(read).toHaveBeenCalledTimes(2);
		await search("nothing-matches-this");
		expect(document.body.textContent).toContain(
			"No matches in available pages or resources",
		);
		expect(document.body.textContent).not.toContain(
			"No matching pages or resources",
		);
	});

	it("preserves keyboard selection, Escape, focus return, query reset and fresh-cache reuse", async () => {
		await mount();
		await openPalette();
		await settled();
		expect(
			client.getQueryData(commandPaletteWorkspacesQueryOptions(12).queryKey),
		).toEqual({ pages: [{ items: [] }], pageParams: [0] });
		await search("go to projects");
		const input = document.querySelector<HTMLInputElement>("input")!;
		expect(document.activeElement).toBe(input);
		await act(async () => {
			input.dispatchEvent(
				new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
			);
			input.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
			);
		});
		expect(reads.navigate).toHaveBeenCalledWith({
			to: "/work",
			search: { app: "portfolio" },
		});
		await openPalette();
		expect(document.querySelector<HTMLInputElement>("input")!.value).toBe("");
		await search("nothing-matches-this");
		await act(async () =>
			document
				.querySelector("input")!
				.dispatchEvent(
					new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
				),
		);
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 50));
		});
		expect(document.activeElement).toBe(button("Open palette"));
		await openPalette();
		expect(document.querySelector<HTMLInputElement>("input")!.value).toBe("");
		for (const read of [
			reads.workspaces,
			reads.outputs,
			reads.apps,
			reads.skills,
			reads.runs,
		])
			expect(read).toHaveBeenCalledTimes(1);
	});
});
