import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";

const graphApi = vi.hoisted(() => ({ visualization: vi.fn() }));
const rationaleApi = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@/lib/api", () => ({
	osApi: {
		memoryGraph: { graph: graphApi },
		rationaleRecords: rationaleApi,
	},
}));

import {
	graphFreshnessNote,
	GRAPH_DEPTH,
	GRAPH_MAX_NODES,
	KnowledgeMap,
	KnowledgeMapEmpty,
	type KnowledgeEdgeInput,
	type KnowledgeNodeInput,
	layoutKnowledgeGraph,
	MemoryExplorer,
	RATIONALE_LIMIT,
	truncateLabel,
} from "./memory-explorer";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TEDI_ID = "11111111-1111-4111-8111-111111111111";

const node = (
	id: string,
	type: KnowledgeNodeInput["type"],
	label = id,
): KnowledgeNodeInput => ({ id, label, type });

const edge = (
	source: string,
	target: string,
	type = "HAS_FACT",
): KnowledgeEdgeInput => ({ source, target, type });

const READY_META = {
	graphConfigured: true,
	graphHealthy: true,
	projectionState: "ready" as const,
	projectionReady: true,
	projectionReason: null,
	persistedWatermark: 10,
	gdsWatermark: 10,
	degraded: false,
	source: "neo4j" as const,
};

const record = (id: string, action: string) => ({
	id,
	tediId: TEDI_ID,
	orgId: "org-1",
	action,
	rationale: "Because the ledger reconciled.",
	category: "content",
	confidence: 0.82,
	evidence: {},
	outcome: "published",
	outcomeStatus: "success" as const,
	approvalRequestId: null,
	objectiveId: null,
	runId: "run-abcdef12",
	workItemId: null,
	toolCallRefs: null,
	proofRef: null,
	createdAt: "2026-08-12T08:30:00.000Z",
	completedAt: "2026-08-12T08:30:00.000Z",
	blameChain: null,
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("truncateLabel", () => {
	it("clips in data because SVG has no text overflow", () => {
		expect(truncateLabel("abcdefghij", 5)).toBe("abcd…");
		expect(truncateLabel("abc", 5)).toBe("abc");
	});
});

describe("layoutKnowledgeGraph", () => {
	const nodes = [
		node("d1", "domain"),
		node("k1", "knowledge_entry"),
		node("f1", "fact"),
		node("f2", "fact"),
	];

	it("places anchors inside and raw evidence outside", () => {
		const layout = layoutKnowledgeGraph(nodes, [edge("d1", "f1")]);
		const byId = new Map(layout.nodes.map((n) => [n.id, n]));
		expect(byId.get("d1")?.ring).toBe(0);
		expect(byId.get("k1")?.ring).toBe(1);
		expect(byId.get("f1")?.ring).toBe(2);
	});

	// A graph with no domains must not leave an empty inner ring and push
	// everything to the rim — the picture would read as "nothing anchors this".
	it("compacts ring values to dense indices when a layer is absent", () => {
		const layout = layoutKnowledgeGraph(
			[node("f1", "fact"), node("f2", "fact")],
			[],
		);
		expect(layout.nodes.every((n) => n.ring === 0)).toBe(true);
	});

	it("keeps every node inside the canvas", () => {
		const layout = layoutKnowledgeGraph(nodes, [edge("d1", "f1")]);
		for (const laid of layout.nodes) {
			expect(laid.x).toBeGreaterThanOrEqual(0);
			expect(laid.x).toBeLessThanOrEqual(layout.size);
			expect(laid.y).toBeGreaterThanOrEqual(0);
			expect(laid.y).toBeLessThanOrEqual(layout.size);
		}
	});

	// An edge to an id that is not in the node set is a line to nowhere. It must
	// be reported, not silently dropped: "no relationships" and "relationships I
	// could not resolve" are different answers.
	it("reports edges pointing outside the returned node set", () => {
		const layout = layoutKnowledgeGraph(nodes, [
			edge("d1", "f1"),
			edge("d1", "ghost"),
		]);
		expect(layout.edges).toHaveLength(1);
		expect(layout.unresolvedEdgeCount).toBe(1);
	});

	it("drops self-edges rather than drawing a zero-length line", () => {
		const layout = layoutKnowledgeGraph(nodes, [edge("d1", "d1")]);
		expect(layout.edges).toHaveLength(0);
		expect(layout.unresolvedEdgeCount).toBe(1);
	});

	it("draws the same graph the same way regardless of read order", () => {
		const forward = layoutKnowledgeGraph(nodes, [
			edge("d1", "f1"),
			edge("k1", "f2"),
		]);
		const reversed = layoutKnowledgeGraph([...nodes].reverse(), [
			edge("k1", "f2"),
			edge("d1", "f1"),
		]);
		expect(
			forward.nodes.map((n) => `${n.id}:${n.x.toFixed(1)}`).sort(),
		).toEqual(reversed.nodes.map((n) => `${n.id}:${n.x.toFixed(1)}`).sort());
		expect(forward.edges.map((e) => e.id)).toEqual(
			reversed.edges.map((e) => e.id),
		);
	});

	// Every ring starting at the same angle stacked small rings into one vertical
	// line: two domains and two skills drew as a column, not as rings.
	it("interleaves rings instead of stacking them on one axis", () => {
		const layout = layoutKnowledgeGraph(
			[
				node("d1", "domain"),
				node("d2", "domain"),
				node("s1", "skill"),
				node("s2", "skill"),
			],
			[],
		);
		const xs = new Set(layout.nodes.map((n) => Math.round(n.x)));
		expect(xs.size).toBeGreaterThan(1);
	});

	// maxNodes is 60; at a fixed radius that many facts render as one smear.
	it("widens a crowded ring so its nodes stay apart", () => {
		const many = Array.from({ length: 60 }, (_unused, index) =>
			node(`f${index}`, "fact"),
		);
		const layout = layoutKnowledgeGraph([node("d1", "domain"), ...many], []);
		const facts = layout.nodes.filter((n) => n.ring === 1);
		const [a, b] = facts;
		expect(a && b).toBeTruthy();
		expect(Math.hypot(a!.x - b!.x, a!.y - b!.y)).toBeGreaterThan(12);
	});

	it("returns an empty, zero-size layout for an empty graph", () => {
		const layout = layoutKnowledgeGraph([], []);
		expect(layout.nodes).toHaveLength(0);
		expect(layout.size).toBe(0);
	});

	it("centers a lone anchor rather than orbiting it around nothing", () => {
		const layout = layoutKnowledgeGraph([node("d1", "domain")], []);
		expect(layout.nodes[0]?.x).toBe(layout.size / 2);
		expect(layout.nodes[0]?.y).toBe(layout.size / 2);
	});
});

describe("graphFreshnessNote", () => {
	it("stays silent when the projection is current", () => {
		expect(graphFreshnessNote(READY_META)).toBe(null);
		expect(graphFreshnessNote(null)).toBe(null);
	});

	// An empty map with an unconfigured projection is not "nothing was learned".
	it("says an unconfigured projection is why the map is empty", () => {
		expect(
			graphFreshnessNote({
				...READY_META,
				graphConfigured: false,
				source: "none",
			}),
		).toContain("empty by configuration");
	});

	it("warns that a catching-up projection may be missing recent facts", () => {
		expect(
			graphFreshnessNote({
				...READY_META,
				projectionState: "catching_up",
				projectionReady: false,
				projectionReason: "backlog 400",
			}),
		).toContain("backlog 400");
	});

	it("warns that a degraded projection is incomplete", () => {
		expect(
			graphFreshnessNote({
				...READY_META,
				projectionState: "degraded",
				degraded: true,
			}),
		).toContain("incomplete");
	});
});

// ---------------------------------------------------------------------------
// Presentational subcomponents
// ---------------------------------------------------------------------------

describe("KnowledgeMap", () => {
	it("announces its contents and labels the anchor rings", () => {
		const layout = layoutKnowledgeGraph(
			[node("d1", "domain", "revenue-reporting"), node("f1", "fact", "a fact")],
			[edge("d1", "f1")],
		);
		const html = renderToStaticMarkup(<KnowledgeMap layout={layout} />);
		expect(html).toContain("Knowledge map: 2 nodes, 1 relationships");
		expect(html).toContain("revenue-reporting");
		expect(html).toContain('data-node-type="domain"');
	});

	it("renders nothing for an empty layout instead of a blank canvas", () => {
		expect(
			renderToStaticMarkup(
				<KnowledgeMap layout={layoutKnowledgeGraph([], [])} />,
			),
		).toBe("");
	});
});

describe("KnowledgeMap surface contract", () => {
	/**
	 * The map frame is a well inside the brain page's memory section — a
	 * bounded canvas, not a card — so it keeps the 8px control radius and takes
	 * its background from the adapter rather than a call-site token.
	 */
	it("is a nested Surface well with adapter-owned chrome", () => {
		const html = renderToStaticMarkup(
			<KnowledgeMap
				layout={layoutKnowledgeGraph([node("d1", "domain", "revenue")], [])}
			/>,
		);
		expect(html).toContain('data-slot="surface"');
		expect(html).toContain('data-tier="well"');
		expect(html).toContain("rounded-lg");
		expect(html).toContain("bg-kumo-base");
		expect(html).toContain("border-kumo-line");
		expect(html).not.toContain("rounded-xl");
	});
});

describe("KnowledgeMapEmpty", () => {
	it("explains what the map would contain", () => {
		expect(renderToStaticMarkup(<KnowledgeMapEmpty />)).toContain(
			"Nothing to map yet",
		);
	});
});

// ---------------------------------------------------------------------------
// Section component
// ---------------------------------------------------------------------------

const cleanups: Array<() => void> = [];

function renderSection(): HTMLElement {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	act(() => {
		root.render(
			<QueryClientProvider client={client}>
				<MemoryExplorer tediId={TEDI_ID} />
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

beforeEach(() => {
	graphApi.visualization.mockReset();
	for (const mock of Object.values(rationaleApi)) mock.mockReset();
	graphApi.visualization.mockResolvedValue({
		nodes: [
			{ id: "d1", label: "revenue-reporting", type: "domain", properties: {} },
			{ id: "f1", label: "a fact", type: "fact", properties: {} },
		],
		edges: [{ source: "d1", target: "f1", type: "HAS_FACT", properties: {} }],
		meta: READY_META,
	});
	rationaleApi.list.mockResolvedValue({
		data: [record("r1", "Publish week-32 revenue summary")],
		pagination: { limit: RATIONALE_LIMIT, offset: 0, total: 1, hasMore: false },
	});
});

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

describe("MemoryExplorer", () => {
	it("reads both canonical endpoints within their declared caps", async () => {
		const container = renderSection();
		await flush();
		expect(
			container.querySelectorAll('[data-slot="page-section"]'),
		).toHaveLength(2);
		expect(container.textContent).toContain(
			"A bounded view of connected concepts",
		);
		expect(container.textContent).toContain("Recorded rationale, outcomes");
		expect(
			container.querySelectorAll('li[data-slot="surface"][data-tier="well"]'),
		).toHaveLength(1);
		expect(graphApi.visualization).toHaveBeenCalledWith(
			{
				view: "knowledge_map",
				tediId: TEDI_ID,
				depth: GRAPH_DEPTH,
				maxNodes: GRAPH_MAX_NODES,
			},
			// The contract-derived option forwards TanStack Query's AbortSignal, so
			// leaving the surface cancels the in-flight read. The hand-written
			// queryFn this replaced passed no signal at all.
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(GRAPH_DEPTH).toBeLessThanOrEqual(5);
		expect(GRAPH_MAX_NODES).toBeLessThanOrEqual(500);

		expect(rationaleApi.list).toHaveBeenCalledWith(
			{ tediId: TEDI_ID, limit: RATIONALE_LIMIT },
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		// rationaleRecords.list inherits the SHARED PaginationSchema cap of 100 —
		// unrelated to the 200/500 windows the runtime-event reads use.
		expect(RATIONALE_LIMIT).toBeLessThanOrEqual(100);
	});

	it("renders the map and reports what it left out", async () => {
		graphApi.visualization.mockResolvedValue({
			nodes: [
				{ id: "d1", label: "revenue", type: "domain", properties: {} },
				{ id: "f1", label: "a fact", type: "fact", properties: {} },
			],
			edges: [
				{ source: "d1", target: "f1", type: "HAS_FACT", properties: {} },
				{ source: "d1", target: "ghost", type: "HAS_FACT", properties: {} },
			],
			meta: READY_META,
		});
		const container = renderSection();
		await flush();
		expect(container.textContent).toContain("2 nodes");
		expect(container.textContent).toContain(
			"1 relationships point outside the drawn subgraph",
		);
	});

	it("carries the projection caveat that came with the map itself", async () => {
		graphApi.visualization.mockResolvedValue({
			nodes: [{ id: "d1", label: "revenue", type: "domain", properties: {} }],
			edges: [],
			meta: {
				...READY_META,
				projectionState: "catching_up",
				projectionReady: false,
				projectionReason: "backlog 400",
			},
		});
		const container = renderSection();
		await flush();
		expect(container.textContent).toContain("still catching up");
	});

	it("distinguishes a refused graph read from a broken one", async () => {
		graphApi.visualization.mockRejectedValue(
			Object.assign(new Error("Forbidden"), { code: "FORBIDDEN" }),
		);
		const container = renderSection();
		await flush();
		expect(container.textContent).toContain(
			"The knowledge map is not readable with your access",
		);
		expect(container.textContent).not.toContain("Nothing to map yet");
	});

	it("surfaces a genuine graph failure with its message", async () => {
		graphApi.visualization.mockRejectedValue(new Error("neo4j unreachable"));
		const container = renderSection();
		await flush();
		expect(container.textContent).toContain("The knowledge map is unavailable");
		expect(container.textContent).toContain("neo4j unreachable");
	});

	it("keeps the decision journal alive when the map read fails", async () => {
		graphApi.visualization.mockRejectedValue(new Error("neo4j unreachable"));
		const container = renderSection();
		await flush();
		expect(container.textContent).toContain("Publish week-32 revenue summary");
	});
});
