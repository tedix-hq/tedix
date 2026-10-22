import type { MemoryHealth } from "@tedix/api-contract/schemas/memory-graph";
import type { MemorySearch } from "@/lib/memory-browser";
import { memorySearchSchema } from "@/lib/memory-browser";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { BrainPage, MemoryVitals } from "./brain-page";

const mocks = vi.hoisted(() => ({
	search: {} as MemorySearch,
	hash: "",
	navigate: vi.fn(),
	browser: vi.fn(),
	refetch: vi.fn(),
	health: {
		isPending: false,
		isError: false,
		data: undefined as MemoryHealth | undefined,
		error: new Error("Sample health read failed"),
	},
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	getRouteApi: () => ({
		useSearch: () => mocks.search,
		useNavigate: () => mocks.navigate,
	}),
	useLocation: ({
		select,
	}: {
		select: (location: { hash: string }) => unknown;
	}) => select({ hash: mocks.hash }),
}));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-query")>()),
	useQuery: () => ({ ...mocks.health, refetch: mocks.refetch }),
}));
vi.mock("./memory-browser", () => ({
	MemoryBrowser: (props: {
		search: MemorySearch;
		onSearch: (patch: Partial<MemorySearch>) => void;
	}) => {
		mocks.browser(props);
		return <section aria-label="Memory browser" />;
	},
}));

const baseHealth: MemoryHealth = {
	totalFacts: 1340,
	activeFacts: 1200,
	archivedFacts: 140,
	totalGaps: 12,
	totalOpinions: 30,
	totalEdges: 4210,
	totalDomains: 9,
	avgConfidence: 0.734,
	orphanRatio: 0.05,
	staleFacts: 0,
	contradictions: 0,
	curiosityQueue: { queued: 3, exploring: 1, completedTotal: 44 },
};

function overview(health = baseHealth) {
	const root = document.createElement("div");
	root.innerHTML = renderToStaticMarkup(<MemoryVitals health={health} />);
	return root;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.search = memorySearchSchema.parse({});
	mocks.hash = "";
	mocks.health = {
		isPending: false,
		isError: false,
		data: baseHealth,
		error: new Error("Sample health read failed"),
	};
});

describe("Memory overview", () => {
	it("renders all eight measured figures with plain labels and provenance", () => {
		const root = overview();
		expect(root.querySelectorAll("dt")).toHaveLength(8);
		expect(
			root.querySelector('[data-vital="active-facts"] dd')?.textContent,
		).toBe("1,200");
		expect(root.querySelector('[data-vital="edges"]')?.textContent).toContain(
			"Connections",
		);
		expect(
			root.querySelector('[data-vital="avg-confidence"] dd')?.textContent,
		).toBe("73.4%");
		expect(
			root.querySelector('[data-vital="curiosity"]')?.textContent,
		).toContain("3 queued · 1 exploring");
		expect(
			root.querySelectorAll('[data-slot="metric-provenance"]'),
		).toHaveLength(8);
		expect(root.textContent).toContain("now · memory health");
	});

	it("keeps every actionable metric linked to the existing browser tab", () => {
		const root = overview();
		expect(
			[...root.querySelectorAll("a")].map((a) => a.getAttribute("href")),
		).toEqual([
			"/brain?tab=gaps",
			"/brain?tab=stale",
			"/brain?tab=contradictions",
			"/brain?tab=curiosity",
		]);
	});

	it("only highlights review and conflict figures when nonzero", () => {
		const clean = overview();
		expect(
			clean.querySelector('[data-vital="stale-facts"] dd')?.className,
		).not.toContain("text-kumo-warning");
		expect(
			clean.querySelector('[data-vital="contradictions"] dd')?.className,
		).not.toContain("text-kumo-danger");
		const flagged = overview({
			...baseHealth,
			staleFacts: 7,
			contradictions: 2,
		});
		expect(
			flagged.querySelector('[data-vital="stale-facts"] dd')?.className,
		).toContain("text-kumo-warning");
		expect(
			flagged.querySelector('[data-vital="contradictions"] dd')?.className,
		).toContain("text-kumo-danger");
	});
});

describe("Brain page", () => {
	it("announces pending health while leaving the browser available", () => {
		mocks.health.data = undefined;
		mocks.health.isPending = true;
		const html = renderToStaticMarkup(<BrainPage />);
		expect(html).toContain('aria-label="Loading memory overview"');
		expect(html).toContain('role="status"');
		expect(html).toContain('aria-label="Memory browser"');
		expect(html).not.toContain('data-vital="active-facts"');
	});

	it("shows a retry and retains cached figures on a failed refresh", () => {
		mocks.health.isError = true;
		const html = renderToStaticMarkup(<BrainPage />);
		expect(html).toContain("Memory health is unavailable");
		expect(html).toContain("Sample health read failed");
		expect(html).toContain("Try again");
		expect(html).toContain('data-vital="active-facts"');
		expect(html).toContain('aria-label="Memory browser"');
	});

	it("resolves legacy lesson links using the shared browser", () => {
		mocks.hash = "lesson-sample-rule";
		renderToStaticMarkup(<BrainPage />);
		expect(mocks.browser).toHaveBeenCalledWith(
			expect.objectContaining({
				search: expect.objectContaining({
					tab: "rules",
					detail: "sample-rule",
				}),
			}),
		);
	});

	it("preserves filters, clears the legacy hash, and pushes section changes", () => {
		mocks.search = memorySearchSchema.parse({ q: "harvest", confidence: "80" });
		renderToStaticMarkup(<BrainPage />);
		const { onSearch } = mocks.browser.mock.lastCall![0];
		onSearch({ tab: "knowledge" });
		expect(mocks.navigate).toHaveBeenLastCalledWith({
			search: { ...mocks.search, tab: "knowledge" },
			hash: "",
			replace: false,
			resetScroll: false,
		});
		onSearch({ q: "delivery" });
		expect(mocks.navigate).toHaveBeenLastCalledWith({
			search: { ...mocks.search, q: "delivery" },
			hash: "",
			replace: true,
			resetScroll: false,
		});
	});
});
