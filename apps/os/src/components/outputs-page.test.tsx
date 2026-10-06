import type {
	OsOutput,
	OsOutputLibraryItem,
} from "@tedix/api-contract/schemas/os-workspaces";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

const outputsApi = vi.hoisted(() => ({
	library: vi.fn(),
	rename: vi.fn(),
	archive: vi.fn(),
}));
const navigate = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({
	osApi: { osWorkspaces: { outputs: outputsApi } },
}));

vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => navigate,
}));
vi.mock("@/components/share-controls", () => ({
	ShareControls: () => <button type="button">Share</button>,
}));

import { OutputsPage } from "./outputs-page";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const OUTPUT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REVISION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const output: OsOutput = {
	id: OUTPUT_ID,
	organizationId: "org-1",
	workspaceId: WORKSPACE_ID,
	kind: "document",
	title: "Weekly report",
	status: "active",
	currentRevisionId: REVISION_ID,
	createdByKind: "user",
	createdById: "user-1",
	createdAt: "2026-08-01T10:00:00.000Z",
	updatedAt: "2026-08-12T10:00:00.000Z",
};

function libraryItem(
	overrides: Partial<OsOutputLibraryItem> = {},
): OsOutputLibraryItem {
	return {
		output,
		workspace: {
			id: WORKSPACE_ID,
			name: "Q3 planning",
			status: "active",
		},
		currentRevision: {
			id: REVISION_ID,
			revision: 2,
			createdAt: output.updatedAt,
		},
		scope: "mine",
		preview: {
			kind: "document",
			lines: ["Weekly plan", "Ship the governed workspace."],
			blockCount: 2,
		},
		...overrides,
	};
}

const cleanups: Array<() => void> = [];
const storage = new Map<string, string>();

function renderPage(): HTMLElement {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	act(() => {
		root.render(
			<QueryClientProvider client={client}>
				<OutputsPage />
			</QueryClientProvider>,
		);
	});
	cleanups.push(() => {
		act(() => root.unmount());
		container.remove();
	});
	return container;
}

async function flush() {
	await act(async () => {
		for (let tick = 0; tick < 5; tick += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	});
}

function clickButton(container: Element, label: string) {
	const button = [...container.querySelectorAll("button")].find((candidate) =>
		(candidate.textContent ?? "").includes(label),
	);
	if (!button) throw new Error(`button not found: ${label}`);
	act(() => button.click());
}

beforeEach(() => {
	for (const method of Object.values(outputsApi)) method.mockReset();
	navigate.mockReset();
	Object.defineProperty(window, "localStorage", {
		configurable: true,
		value: {
			clear: () => storage.clear(),
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => storage.set(key, value),
			removeItem: (key: string) => storage.delete(key),
			key: (index: number) => [...storage.keys()][index] ?? null,
			get length() {
				return storage.size;
			},
		},
	});
	window.localStorage.clear();
});

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

describe("OutputsPage", () => {
	it("uses the ordinary desktop lane for the compact filter row", async () => {
		outputsApi.library.mockResolvedValue({
			items: [libraryItem()],
			truncated: false,
		});
		const container = renderPage();
		await flush();

		const toolbar = container.querySelector('[data-slot="page-toolbar"]');
		expect(toolbar?.className).toContain("lg:flex-row");
		expect(toolbar?.className).not.toContain("xl:flex-row");
		const searchGroup = toolbar?.querySelector(".lg\\:w-auto");
		expect(searchGroup).not.toBeNull();
		expect(searchGroup?.className).toContain("flex-col");
		expect(searchGroup?.className).toContain("sm:flex-row");
		const scopeButton = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.includes("Yours and shared"),
		);
		expect(scopeButton?.className).toContain("w-full");
		expect(scopeButton?.className).toContain("justify-between");
		expect(scopeButton?.className).toContain("sm:w-auto");
		const search = container.querySelector('[aria-label="Search outputs"]');
		expect(search?.parentElement?.className).toContain("w-full");
		expect(search?.parentElement?.className).toContain("sm:w-60");
	});

	it("opens an active workspace-backed output in the collaborative workbench", async () => {
		outputsApi.library.mockResolvedValue({
			items: [libraryItem()],
			truncated: false,
		});
		const container = renderPage();
		await flush();

		const card = container.querySelector('li[role="button"]');
		expect(card).not.toBeNull();
		act(() => (card as HTMLElement).click());

		expect(navigate).toHaveBeenCalledWith({
			to: "/workspace/$workspaceId",
			params: { workspaceId: WORKSPACE_ID },
			search: {
				workpiece: `output:${OUTPUT_ID}`,
				pane: "workpiece",
			},
		});
	});

	/**
	 * Every tile in the gallery looks the same, so every tile must behave the
	 * same. A workspace-less output cannot open into the workbench, but it has
	 * a durable detail route — its preview must reach that route rather than
	 * being the one silently inert card in an otherwise clickable grid.
	 */
	it("gives every gallery card a working open affordance, workspace or not", async () => {
		const orgOutputId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
		const archivedOutputId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
		outputsApi.library.mockResolvedValue({
			items: [
				libraryItem(),
				libraryItem({
					output: {
						...output,
						id: orgOutputId,
						workspaceId: null,
						kind: "presentation",
						title: "Investor Update Deck",
					},
					workspace: null,
					preview: {
						kind: "presentation",
						title: "August update",
						bullets: ["Revenue"],
						slideCount: 3,
					},
				}),
				libraryItem({
					output: { ...output, id: archivedOutputId, title: "Old plan" },
					workspace: {
						id: WORKSPACE_ID,
						name: "Archived planning",
						status: "archived",
					},
				}),
			],
			truncated: false,
		});
		const container = renderPage();
		await flush();

		const cards = [...container.querySelectorAll(".output-grid-card")];
		expect(cards).toHaveLength(3);
		expect(cards.map((card) => card.getAttribute("aria-label"))).toEqual([
			"Open Weekly report in Q3 planning",
			"Open Investor Update Deck",
			"Open Old plan",
		]);

		for (const card of cards) {
			const preview = card.querySelector('[data-slot="output-grid-preview"]');
			expect(preview).not.toBeNull();
			act(() => (preview as HTMLElement).click());
		}

		expect(navigate.mock.calls.map(([call]) => call)).toEqual([
			{
				to: "/workspace/$workspaceId",
				params: { workspaceId: WORKSPACE_ID },
				search: { workpiece: `output:${OUTPUT_ID}`, pane: "workpiece" },
			},
			{ to: "/outputs/$outputId", params: { outputId: orgOutputId } },
			{ to: "/outputs/$outputId", params: { outputId: archivedOutputId } },
		]);
	});

	it("keeps revoked outputs visible but makes their content preview inert", async () => {
		outputsApi.library.mockResolvedValue({
			items: [
				libraryItem({
					preview: {
						kind: "unavailable",
						reason: "source_access_unavailable",
					},
				}),
			],
			truncated: false,
		});
		const container = renderPage();
		await flush();
		const card = container.querySelector(".output-grid-card") as HTMLElement;
		expect(card).not.toBeNull();
		expect(card.getAttribute("aria-disabled")).toBe("true");
		expect(card.getAttribute("role")).not.toBe("button");
		expect(container.textContent).toContain("Source access unavailable");
		expect(container.textContent).not.toContain("Weekly plan");
		expect(container.textContent).not.toContain("Share");
		act(() => card.click());
		expect(navigate).not.toHaveBeenCalled();
	});

	it("labels unavailable source content visibly in list layout", async () => {
		window.localStorage.setItem("tedix:outputs:layout:v1", "list");
		outputsApi.library.mockResolvedValue({
			items: [
				libraryItem({
					preview: {
						kind: "unavailable",
						reason: "source_access_unavailable",
					},
				}),
			],
			truncated: false,
		});
		const container = renderPage();
		await flush();
		const row = container.querySelector("li[aria-disabled='true']");
		expect(row).not.toBeNull();
		expect(row?.textContent).toContain("Source access unavailable");
		expect(row?.getAttribute("role")).not.toBe("button");
	});

	it("replaces a failed cold load with an actionable retry", async () => {
		outputsApi.library
			.mockRejectedValueOnce(new Error("API request timed out after 15000ms"))
			.mockResolvedValueOnce({ items: [libraryItem()], truncated: false });
		const container = renderPage();
		await flush();
		expect(container.querySelector(".outputs-surface")).not.toBeNull();

		expect(container.textContent).toContain("Outputs are unavailable");
		expect(container.textContent).toContain(
			"API request timed out after 15000ms",
		);
		clickButton(container, "Try again");
		await flush();

		expect(outputsApi.library).toHaveBeenCalledTimes(2);
		expect(container.textContent).toContain("Weekly report");
	});

	it("renders bounded previews, provenance, format counts, and persists layout", async () => {
		outputsApi.library.mockResolvedValue({
			items: [
				libraryItem(),
				libraryItem({
					output: {
						...output,
						id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
						kind: "sheet",
						title: "Pipeline",
						createdByKind: "tedi",
						createdById: "tedi-1",
					},
					scope: "organization",
					workspace: {
						id: WORKSPACE_ID,
						name: "Archived planning",
						status: "archived",
					},
					preview: {
						kind: "sheet",
						columns: ["Deal", "Value"],
						rows: [["Acme", 1200]],
						rowCount: 1,
						columnCount: 2,
						sheetCount: 1,
					},
				}),
				libraryItem({
					output: {
						...output,
						id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
						kind: "presentation",
						title: "Board deck",
					},
					preview: {
						kind: "presentation",
						title: "Q3 priorities",
						bullets: ["Revenue", "Retention"],
						slideCount: 3,
					},
				}),
			],
			truncated: false,
		});
		const container = renderPage();
		await flush();

		expect(container.textContent).toContain("Weekly plan");
		expect(container.textContent).toContain("Acme");
		expect(container.textContent).toContain("Q3 priorities");
		expect(container.querySelector(".shadow-tedix-raised")).not.toBeNull();
		expect(container.textContent).toContain("Created by you");
		expect(container.textContent).toContain("Shared by a tedi");
		expect(container.textContent).toContain("Archived workspace");
		expect(container.textContent).toContain("Documents 1");
		expect(container.textContent).toContain("Sheets 1");
		expect(container.textContent).toContain("Slides 1");
		expect(container.textContent).toContain("2 blocks, updated");
		/**
		 * A library tile sits directly on the page canvas as a peer of a `Card`,
		 * so it takes the `Surface` card tier (12px) rather than a hand-rolled
		 * `rounded-lg border border-kumo-* bg-kumo-*`. Its preview clip must
		 * follow the same tier, or the top corners stop matching the frame.
		 */
		const gridCard = container.querySelector(".output-grid-card");
		expect(gridCard?.tagName).toBe("LI");
		expect(gridCard?.getAttribute("data-slot")).toBe("surface");
		expect(gridCard?.getAttribute("data-tier")).toBe("panel");
		expect(gridCard?.className).toContain("rounded-xl");
		expect(gridCard?.className).toContain("border-kumo-line");
		expect(gridCard?.className).toContain("bg-kumo-base");
		expect(gridCard?.className).not.toContain("rounded-lg");
		const gridPreview = gridCard?.querySelector(
			'[data-slot="output-grid-preview"]',
		);
		expect(
			gridCard?.querySelector(
				'[data-slot="icon-frame"][data-appearance="outline"][data-size="sm"]',
			),
		).not.toBeNull();
		expect(gridPreview?.className).toContain("rounded-t-xl");
		expect(gridPreview?.className).not.toContain("rounded-t-lg");
		expect(gridPreview?.className).toContain("aspect-video");
		expect(gridPreview?.className).toContain("sm:aspect-[4/3]");
		const typeTabs = container.querySelectorAll('[role="tab"]');
		expect(typeTabs).toHaveLength(5);
		const typeTabList = container.querySelector(
			'[role="tablist"][aria-label="Filter by type"]',
		);
		expect(typeTabList?.getAttribute("data-variant")).toBe("filter");
		expect(typeTabList?.className).toContain("overflow-x-auto");
		expect(
			container.querySelector('[data-kumo-part="overflow-control"]'),
		).toBeNull();
		expect(typeTabs[0]?.getAttribute("aria-selected")).toBe("true");
		act(() => (typeTabs[3] as HTMLButtonElement).click());
		expect(typeTabs[3]?.getAttribute("aria-selected")).toBe("true");
		expect(container.textContent).toContain("Board deck");
		expect(container.textContent).not.toContain("Weekly report");
		expect(container.querySelector("ul")?.className).toContain("grid-cols-1");
		expect(container.querySelector("ul")?.className).toContain(
			"sm:grid-cols-2",
		);
		expect(container.querySelector("ul")?.className).toContain(
			"md:grid-cols-3",
		);
		expect(container.querySelector("ul")?.className).toContain(
			"lg:grid-cols-4",
		);
		expect(container.querySelector("ul")?.className).not.toContain("sm:px-3");
		const listButton = container.querySelector(
			'button[aria-pressed="false"]',
		) as HTMLButtonElement;
		expect(listButton.textContent).toContain("List view");
		act(() => listButton.click());
		expect(listButton.getAttribute("aria-pressed")).toBe("true");
		expect(
			container.querySelector('button[aria-pressed="false"]')?.textContent,
		).toContain("Grid view");
		expect(window.localStorage.getItem("tedix:outputs:layout:v1")).toBe("list");
		expect(
			container.querySelector(
				'[data-slot="icon-frame"][data-appearance="outline"][data-size="md"]',
			),
		).not.toBeNull();
	});

	it("progressively reveals a large output library", async () => {
		outputsApi.library.mockResolvedValue({
			items: Array.from({ length: 25 }, (_, index) =>
				libraryItem({
					output: {
						...output,
						id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`,
						title: `Output ${index + 1}`,
					},
				}),
			),
			truncated: false,
		});
		const container = renderPage();
		await flush();

		expect(container.querySelectorAll(".output-grid-card")).toHaveLength(20);
		expect(container.textContent).toContain("Showing 20 of 25 outputs");
		clickButton(container, "Show more");
		expect(container.querySelectorAll(".output-grid-card")).toHaveLength(25);
		expect(container.textContent).toContain("Showing 25 of 25 outputs");
	});
});
