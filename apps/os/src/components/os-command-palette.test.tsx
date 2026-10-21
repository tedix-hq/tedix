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
	matchesCommand,
	OsCommandPalette,
	pageCommands,
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
	navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	useNavigate: () => reads.navigate,
	useLocation: () => "/work",
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
	it("matches title and description tokens without case sensitivity", () => {
		expect(matchesCommand(command, "canvas")).toBe(true);
		expect(matchesCommand(command, "APP previews")).toBe(true);
	});

	it("requires every search token", () => {
		expect(matchesCommand(command, "workspace policy")).toBe(false);
		expect(matchesCommand(command, "   ")).toBe(true);
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
		reads.navigate.mockReset();
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
		expect(document.body.textContent).toContain("Go to Projects");
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
		expect(document.body.textContent).toContain("Go to Projects");
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
		).toEqual({ items: [] });
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
