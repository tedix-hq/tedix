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
vi.mock("@/components/artifact-release-review", () => ({
	ArtifactReleaseReview: () => null,
}));
vi.mock("@/components/chat-cards", () => ({
	compactPreview: () => null,
	RunStatusChip: () => null,
}));

import { HomeExecutionDetailPage } from "./home-execution-detail";

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
