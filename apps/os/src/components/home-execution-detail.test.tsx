import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

const reads = vi.hoisted(() => ({ run: vi.fn(), trace: vi.fn() }));
vi.mock("@/lib/os-query-options", () => ({
	homeRunQueryOptions: (runId: string) => ({
		queryKey: ["run", runId],
		queryFn: () => reads.run(runId),
	}),
	homeRunTraceQueryOptions: (runId: string) => ({
		queryKey: ["trace", runId],
		queryFn: () => reads.trace(runId),
	}),
	homeChildRunEvidenceQueryOptions: () => ({
		queryKey: ["child"],
		queryFn: async () => ({}),
	}),
	osQuery: {
		kernelRuntime: {
			readRunEvents: {
				queryOptions: () => ({
					queryKey: ["events"],
					queryFn: async () => ({ events: [] }),
				}),
			},
		},
	},
}));
vi.mock("@/lib/use-tedi-names", () => ({ useTediNames: () => ({}) }));
vi.mock("@tanstack/react-router", () => ({
	Link: ({ children }: { children?: unknown }) => <a>{children as never}</a>,
}));
vi.mock("@/components/artifact-release-review", () => ({
	ArtifactReleaseReview: () => null,
}));
vi.mock("@/components/chat-cards", () => ({
	compactPreview: () => null,
	RunStatusChip: () => null,
}));

import {
	DelegatedResultView,
	HomeExecutionDetailPage,
	HomeExecutionDetailView,
} from "./home-execution-detail";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const RUN_ID = "11111111-1111-4111-8111-111111111111";
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
async function flush() {
	await act(async () => {
		for (let i = 0; i < 6; i++)
			await new Promise((resolve) => setTimeout(resolve, 0));
	});
}
async function mount() {
	act(() =>
		root.render(
			<QueryClientProvider client={client}>
				<HomeExecutionDetailPage runId={RUN_ID} />
			</QueryClientProvider>,
		),
	);
	await flush();
}
beforeEach(() => {
	vi.resetAllMocks();
	reads.run.mockImplementation(() => new Promise(() => {}));
	reads.trace.mockImplementation(() => new Promise(() => {}));
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(() => {
	act(() => root.unmount());
	client.clear();
	host.remove();
});

describe("Home execution read states", () => {
	it("keeps the durable failed run and navigation visible when its trace fails", async () => {
		reads.run.mockResolvedValue({
			run: {
				id: RUN_ID,
				conversationId: "conversation",
				status: "failed",
				metadata: { childRunPreview: "The worker stopped before finishing." },
			},
		});
		reads.trace.mockRejectedValue(new Error("Trace evidence unavailable"));
		await mount();
		expect(host.querySelector('[aria-label="Saved execution"]')).not.toBeNull();
		expect(host.textContent).toContain("The worker stopped before finishing.");
		expect(host.textContent).toContain("Trace evidence unavailable");
		expect(host.textContent).toContain("Retry execution trace");
		expect(host.textContent).toContain("Back to conversation");
	});

	it("shows the supplied copyable Home run identity while both reads are pending", async () => {
		await mount();
		expect(host.textContent).toContain(RUN_ID);
		expect(host.textContent).toContain("Home run");
		expect(
			host.querySelector('[aria-label="Loading Home execution"]'),
		).not.toBeNull();
		expect(host.querySelector("button")).not.toBeNull();
	});

	it.each(["run", "trace"] as const)(
		"does not hide a failed %s read behind the other pending read",
		async (failed) => {
			reads[failed].mockRejectedValue(
				new Error("Forbidden: conversation access denied"),
			);
			await mount();
			expect(host.textContent).toContain(
				"Forbidden: conversation access denied",
			);
			expect(host.textContent).toContain(RUN_ID);
			expect(host.textContent).not.toContain("not found");
			expect(
				host.querySelector('[aria-label="Loading Home execution"]'),
			).toBeNull();
			expect(
				[...host.querySelectorAll("button")].some((button) =>
					button.textContent?.startsWith("Retry"),
				),
			).toBe(true);
		},
	);

	it.each(["run", "trace"] as const)(
		"retries only the failed %s read while the other dependency is pending",
		async (failed) => {
			reads[failed]
				.mockRejectedValueOnce(new Error("Read unavailable"))
				.mockResolvedValueOnce(
					failed === "run"
						? { run: { status: "completed" } }
						: { trace: { branches: [] } },
				);
			await mount();
			const retry = [...host.querySelectorAll("button")].find(
				(button) =>
					button.textContent ===
					(failed === "run" ? "Retry Home execution" : "Retry execution trace"),
			);
			if (!retry) throw new Error("Missing failed-read retry");
			expect(retry.disabled).toBe(false);
			act(() => retry.click());
			await flush();
			expect(reads[failed]).toHaveBeenCalledTimes(2);
			expect(reads[failed === "run" ? "trace" : "run"]).toHaveBeenCalledTimes(
				1,
			);
			expect(host.textContent).not.toContain("Read unavailable");
			expect(host.textContent).toContain(RUN_ID);
			expect(
				host.querySelector('[aria-label="Loading Home execution"]'),
			).not.toBeNull();
		},
	);

	it("reports both completed errors with independent retry controls", async () => {
		reads.run.mockRejectedValue(new Error("Run read unavailable"));
		reads.trace.mockRejectedValue(new Error("Trace read unavailable"));
		await mount();
		expect(host.textContent).toContain("Run read unavailable");
		expect(host.textContent).toContain("Trace read unavailable");
		expect(host.textContent).toContain("Retry Home execution");
		expect(host.textContent).toContain("Retry execution trace");
	});
});

it("shows actual personal account reads once on the run", async () => {
	const notice = "Read your Gmail (owner@example.test) for this request";
	const props: Parameters<typeof HomeExecutionDetailView>[0] = {
		embedded: true,
		run: {
			id: RUN_ID,
			organizationId: "org",
			createdAt: "2026-10-23T12:00:00Z",
			status: "completed",
			conversationId: "conversation",
			metadata: {},
		},
		trace: {
			version: "home-run-trace.v1",
			organizationId: "org",
			conversationId: "conversation",
			homeRunId: RUN_ID,
			traceBundleId: null,
			harnessVersionId: null,
			status: "completed",
			branches: [],
			wakeReceipts: [],
			synthesis: [],
			eventIds: { kernel: [], tedi: [], audit: [] },
			artifactIds: [],
			assembledAt: "2026-10-23T12:00:00Z",
			sources: [],
			health: {
				status: "healthy",
				findings: [],
				counts: { errors: 0, warnings: 0 },
			},
			latency: {
				parentElapsedMs: 100,
				maxWakeQueueMs: null,
				finalWakeToSynthesisMs: null,
			},
			complete: true,
			gaps: [],
			parentEventIds: [],
		},
		events: [
			{
				id: "use-1",
				kind: "context.injected",
				createdAt: "2026-10-23T12:00:00Z",
				payload: { personalAccountRead: { notice } },
			},
			{
				id: "use-2",
				kind: "context.injected",
				createdAt: "2026-10-23T12:00:01Z",
				payload: { personalAccountRead: { notice } },
			},
		],
	};
	act(() => root.render(<HomeExecutionDetailView {...props} />));
	await flush();
	const accounts = host.querySelector('[aria-label="Personal accounts used"]');
	expect(accounts?.textContent).toBe(notice);
	expect(host.textContent?.match(/Read your Gmail/g)).toHaveLength(1);
});

it("shows the delegated run's settled cost instead of the kernel's routing cost", async () => {
	const props: Parameters<typeof HomeExecutionDetailView>[0] = {
		embedded: true,
		run: {
			id: RUN_ID,
			organizationId: "org",
			createdAt: "2026-10-23T12:00:00Z",
			status: "completed",
			conversationId: "conversation",
			delegatedTediId: "cfo",
			childRunId: "cfo:mcp:child",
			usage: {
				pricing: null,
				inputTokens: 10,
				outputTokens: 5,
				reasoningTokens: null,
				totalTokens: 15,
				costUsd: 0.0042,
			},
			settledCharge: { currency: "eur", chargedMicros: 40_000, chargeCount: 3 },
			metadata: {},
		},
		trace: {
			version: "home-run-trace.v1",
			organizationId: "org",
			conversationId: "conversation",
			homeRunId: RUN_ID,
			traceBundleId: null,
			harnessVersionId: null,
			status: "completed",
			branches: [],
			wakeReceipts: [],
			synthesis: [],
			eventIds: { kernel: [], tedi: [], audit: [] },
			artifactIds: [],
			assembledAt: "2026-10-23T12:00:00Z",
			sources: [],
			health: {
				status: "healthy",
				findings: [],
				counts: { errors: 0, warnings: 0 },
			},
			latency: {
				parentElapsedMs: 100,
				maxWakeQueueMs: null,
				finalWakeToSynthesisMs: null,
			},
			complete: true,
			gaps: [],
			parentEventIds: [],
		},
		events: [],
	};
	act(() => root.render(<HomeExecutionDetailView {...props} />));
	await flush();
	const summary = host.querySelector('[aria-label="Response summary"]');
	expect(summary?.textContent).toContain("€0.04 settled for the delegated run");
	expect(summary?.textContent).not.toContain("Home only");
});

const CHILD_RUN = `e142d015-799c-465b-a564-d3795e8e9f75:mcp:cfo-memory-check-home-${RUN_ID}`;
// Elapsed-time copy reads Date.now() at render; pin it so "1m 35s" is exact.
const NOW = Date.parse("2026-10-23T12:00:00Z");
const runningRun = {
	id: `cfo-memory-check-home-${RUN_ID}`,
	conversationId: RUN_ID,
	status: "running",
	startedAt: new Date(NOW - 95_000).toISOString(),
	createdAt: new Date(NOW - 95_000).toISOString(),
	metadata: { workItemId: "a701383c-ca5b-4771-b9fc-845e39d65b03" },
} as never;
const runningTrace = {
	complete: false,
	gaps: [
		"parent_not_terminal",
		`child_not_terminal:${CHILD_RUN}`,
		"request_acceptance_unverified",
	],
	parentEventIds: ["e1"],
	latency: { parentElapsedMs: null },
	health: { status: "healthy" },
	branches: [
		{
			delegatedTediId: "cfo",
			childRunId: CHILD_RUN,
			workItemId: "a701383c-ca5b-4771-b9fc-845e39d65b03",
			status: "running",
			eventIds: Array.from({ length: 21 }, (_, i) => `e${i}`),
			toolEventIds: [],
			artifactIds: [],
		},
	],
} as never;

describe("Response details copy", () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("keeps the delegation details visible when the evidence read fails", () => {
		act(() =>
			root.render(
				<HomeExecutionDetailView
					run={runningRun}
					trace={runningTrace}
					branchId={CHILD_RUN}
					embedded
					evidenceError={new Error("Delegation evidence unavailable")}
				/>,
			),
		);
		expect(host.textContent).toContain("In progress");
		expect(host.textContent).toContain("Delegation evidence unavailable");
		expect(
			host.querySelector('[aria-label="Loading delegation evidence"]'),
		).toBeNull();
	});

	it("shows plain-language trace notes and no raw codes for a running delegation", () => {
		act(() =>
			root.render(
				<QueryClientProvider client={client}>
					<HomeExecutionDetailView
						run={runningRun}
						trace={runningTrace}
						branchId={CHILD_RUN}
						onSelectBranch={() => {}}
						tediNames={{ cfo: "CFO" }}
						evidence={
							{
								status: "running",
								preview: 'Raw result: ```json\n{"__tedix_truncated":true}\n```',
								events: [],
								artifacts: [],
								delegatedTediId: "cfo",
							} as never
						}
						embedded
						events={[]}
					/>
				</QueryClientProvider>,
			),
		);
		const text = host.textContent ?? "";
		expect(text).toContain("In progress");
		expect(text).toContain("CFO's delegated run hasn't finished.");
		expect(text).toContain("Result not yet checked against the request.");
		expect(text).toContain("Running for 1m 35s");
		expect(text).toContain("Still working…");
		expect(text).toContain("Showing");
		for (const raw of [
			"parent_not_terminal",
			"child_not_terminal",
			"request_acceptance_unverified",
			"__tedix_truncated",
			"Trace has gaps",
			"Not recorded",
		])
			expect(text).not.toContain(raw);
		// The branch id is never printed; long ids appear only in copy fields.
		expect(text).not.toContain(":mcp:");
	});

	it("shows a running delegation's progress and its own events, even before the trace lists it", () => {
		const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
		act(() =>
			root.render(
				<QueryClientProvider client={client}>
					<HomeExecutionDetailView
						run={
							{
								...(runningRun as object),
								delegatedTediId: "cfo",
								childRunId: CHILD_RUN,
								updatedAt: ago(20_000),
								progress: {
									current: 48,
									total: 100,
									label: "Working",
									detail: "Writing the weekly summary",
								},
							} as never
						}
						trace={{ ...(runningTrace as object), branches: [] } as never}
						branchId={CHILD_RUN}
						tediNames={{ cfo: "CFO" }}
						evidence={
							{
								status: "running",
								preview: null,
								events: [
									{
										id: "c2",
										kind: "tool.completed",
										toolCallId: "t1",
										payload: { name: "ledger__read" },
										createdAt: ago(30_000),
									},
									{
										id: "c1",
										kind: "tool.started",
										toolCallId: "t1",
										payload: { name: "ledger__read" },
										createdAt: ago(40_000),
									},
								],
								artifacts: [],
								delegatedTediId: "cfo",
							} as never
						}
						embedded
						events={[]}
					/>
				</QueryClientProvider>,
			),
		);
		const text = host.textContent ?? "";
		expect(text).not.toContain("Delegation not found");
		expect(text).toContain("Writing the weekly summary");
		expect(text).toContain("48 of 100");
		expect(text).toMatch(/last activity 20s ago/);
		expect(text).toContain("CFO's events");
		const events = host.querySelector('[aria-label="Delegated events"]');
		expect(events?.textContent).toMatch(/Tool started.*Tool completed/);
	});

	it("renders a completed child's answer as formatted text", () => {
		act(() =>
			root.render(
				<DelegatedResultView
					evidence={{ status: "completed", preview: "Cash is **€12k**." }}
					tediName="CFO"
				/>,
			),
		);
		expect(host.querySelector("strong")?.textContent).toBe("€12k");
		expect(host.textContent).not.toContain("Show raw");
	});

	it("keeps structured output behind a collapsed Show raw disclosure", () => {
		act(() =>
			root.render(
				<DelegatedResultView
					evidence={{
						status: "completed",
						preview: 'Raw result: ```json\n[{"callable":"memory.search"}]\n```',
					}}
					tediName="CFO"
				/>,
			),
		);
		expect(host.textContent).toContain(
			"CFO returned data instead of a written answer.",
		);
		expect(host.textContent).toContain("Show raw");
		expect(host.textContent).not.toContain("memory.search");
	});
});
