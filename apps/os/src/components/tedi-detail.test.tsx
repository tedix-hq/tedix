import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TediType } from "@tedix/api-contract/schemas/tedi";
import { act } from "react";
import type { ReactNode } from "react";
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

const TEDI_ID = "11111111-1111-4111-8111-111111111111";

// The route component reads its param and renders TanStack links; neither works
// without a RouterProvider, so the router surface this file touches is stubbed.
vi.mock("@tanstack/react-router", () => ({
	useParams: () => ({ tediId: TEDI_ID }),
	useRouterState: () => `/team/${TEDI_ID}`,
	Outlet: () => <div>Nested tedi route</div>,
	Link: ({ children, ...props }: { children?: ReactNode }) => (
		<a href="/team" {...props}>
			{children}
		</a>
	),
}));

const tedisApi = vi.hoisted(() => ({
	get: vi.fn(),
	list: vi.fn(),
	listOperationsSummaries: vi.fn(),
}));
const delegationApi = vi.hoisted(() => ({ getProfile: vi.fn() }));
const runtimeApi = vi.hoisted(() => ({ listEvents: vi.fn() }));
const growthApi = vi.hoisted(() => ({ latest: vi.fn() }));
const memoryGraphApi = vi.hoisted(() => ({
	expertise: vi.fn(),
	graph: { visualization: vi.fn() },
}));
const rationaleApi = vi.hoisted(() => ({
	list: vi.fn(),
	getExplanation: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
	osApi: {
		tedis: tedisApi,
		earnedDelegation: delegationApi,
		cognitiveRuntime: runtimeApi,
		growthSnapshots: growthApi,
		memoryGraph: memoryGraphApi,
		rationaleRecords: rationaleApi,
	},
}));

import { TediDetailHeader, TediDetailPage } from "./tedi-detail";
import * as localInference from "@/lib/local-inference";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const T = "2026-08-12T08:30:00.000Z";

const tedi = (overrides: Partial<TediType> = {}): TediType =>
	({
		id: TEDI_ID,
		organizationId: "org-1",
		name: "miles",
		slug: "miles",
		displayName: "Miles",
		avatar: null,
		personality: "Numbers-first revenue analyst",
		status: "active",
		scope: "org",
		runtimeStatus: "running",
		lastActivityAt: T,
		lastSeenAt: T,
		...overrides,
	}) as unknown as TediType;

const summary = () => ({
	tediId: TEDI_ID,
	delegationProfile: {
		activeRole: { roleName: "Revenue analyst", careerStage: "operator" },
		entrustments: [{ effectiveStatus: "active" as const }],
	},
	pulse: { decisionsLast24h: 6, factsLearnedLast24h: 3 },
});

// ---------------------------------------------------------------------------
// Presentational subcomponents
// ---------------------------------------------------------------------------

describe("TediDetailHeader", () => {
	it("labels local inventory without claiming runtime execution or recent activity", () => {
		const local = vi
			.spyOn(localInference, "isLocalSession")
			.mockReturnValue(true);
		try {
			const html = renderToStaticMarkup(<TediDetailHeader tedi={tedi()} />);
			expect(html).toContain("Configured");
			expect(html).toContain("local execution unavailable");
			expect(html).not.toContain("Running");
			expect(html).not.toContain("Active");
		} finally {
			local.mockRestore();
		}
	});
	it("keeps Cloud runtime and activity labels", () => {
		const local = vi
			.spyOn(localInference, "isLocalSession")
			.mockReturnValue(false);
		try {
			const html = renderToStaticMarkup(<TediDetailHeader tedi={tedi()} />);
			expect(html).toContain("Running");
			expect(html).toContain("Active");
			expect(html).not.toContain("local execution unavailable");
		} finally {
			local.mockRestore();
		}
	});
	it("names the tedi, its role, and what it is actually entrusted to do", () => {
		const html = renderToStaticMarkup(
			<TediDetailHeader tedi={tedi()} summary={summary()} />,
		);
		expect(html).toContain("Miles");
		expect(html).toContain("Revenue analyst · operator");
		expect(html).toContain("1 active entrustment");
		expect(html).toContain("6 decisions");
	});

	// A title with no entrustment authorizes nothing, and the header must not
	// leave that blank where a role name would otherwise imply authority.
	it("says observe-only when nothing is entrusted", () => {
		const html = renderToStaticMarkup(
			<TediDetailHeader
				tedi={tedi()}
				summary={{
					...summary(),
					delegationProfile: {
						...summary().delegationProfile,
						entrustments: [],
					},
				}}
			/>,
		);
		expect(html).toContain("observe-only — no entrustments");
	});

	it("makes no authority claim when the roster carries no summary", () => {
		// An absent summary means the read has not landed OR this tedi is
		// excluded from the operations summaries — neither is evidence that
		// nothing is entrusted, and the canonical profile rendered below can
		// list active grants. Claiming observe-only here would contradict it.
		const html = renderToStaticMarkup(<TediDetailHeader tedi={tedi()} />);
		expect(html).toContain("Numbers-first revenue analyst");
		expect(html).not.toContain("observe-only");
		expect(html).not.toContain("Authority");
	});
});

// ---------------------------------------------------------------------------
// Route component
// ---------------------------------------------------------------------------

const cleanups: Array<() => void> = [];

function renderPage(): HTMLElement {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	act(() => {
		root.render(
			<QueryClientProvider client={client}>
				<TediDetailPage />
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
	for (const mock of [
		...Object.values(tedisApi),
		...Object.values(delegationApi),
		...Object.values(runtimeApi),
		...Object.values(growthApi),
		memoryGraphApi.expertise,
		memoryGraphApi.graph.visualization,
		...Object.values(rationaleApi),
	]) {
		mock.mockReset();
	}
	tedisApi.list.mockResolvedValue({
		data: [tedi()],
		pagination: {
			limit: 100,
			offset: 0,
			total: 1,
			hasMore: false,
		},
	});
	tedisApi.get.mockResolvedValue(tedi());
	tedisApi.listOperationsSummaries.mockResolvedValue({ data: [summary()] });
	delegationApi.getProfile.mockRejectedValue(new Error("not under test"));
	runtimeApi.listEvents.mockResolvedValue({ events: [], nextBefore: null });
	growthApi.latest.mockResolvedValue(null);
	memoryGraphApi.expertise.mockResolvedValue({ expertise: [] });
	memoryGraphApi.graph.visualization.mockResolvedValue({
		nodes: [],
		edges: [],
		meta: undefined,
	});
	rationaleApi.list.mockResolvedValue({
		data: [],
		pagination: { limit: 25, offset: 0, total: 0, hasMore: false },
	});
});

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

describe("TediDetailPage", () => {
	it("reads the exact tedi id and shared operations summary", async () => {
		renderPage();
		await flush();
		expect(tedisApi.get).toHaveBeenCalledWith(
			{ tediId: TEDI_ID },
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(tedisApi.listOperationsSummaries).toHaveBeenCalledTimes(1);
	});

	it("renders lazy sibling navigation and its nested outlet", async () => {
		const container = renderPage();
		await flush();
		expect(
			container.querySelector(
				'[role="tablist"][aria-label="Tedi detail sections"]',
			),
		).not.toBeNull();
		expect(
			container.querySelector('[role="tab"][aria-selected="true"]')
				?.textContent,
		).toBe("Overview");
		expect(container.textContent).toContain("Overview");
		expect(container.textContent).toContain("Authority");
		expect(container.textContent).toContain("Tool telemetry");
		expect(container.textContent).toContain("Learning");
		expect(container.textContent).toContain("Memory");
		expect(container.textContent).toContain("Settings");
		expect(container.textContent).toContain("Nested tedi route");
	});

	it("reports a failed exact detail read without hiding navigation", async () => {
		tedisApi.get.mockRejectedValue(new Error("D1 unavailable"));
		const container = renderPage();
		await flush();
		expect(container.textContent).toContain("The tedi roster is unavailable");
		expect(container.textContent).toContain("Nested tedi route");
	});
});
