import { WorkspaceVerificationPausedContext } from "@/lib/workspace-verification";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
	read: vi.fn(),
	candidateMounts: 0,
	authority: { role: "owner", permissions: ["secrets:manage"] },
}));
vi.mock("@/lib/use-os-preferences", () => ({
	useOsOperationalContext: () => ({ data: { authority: mocks.authority } }),
}));
vi.mock("@/lib/os-query-options", () => ({
	workRepositoryReviewQueryOptions: (input: unknown) => ({
		queryKey: ["repository-review-test", input],
		queryFn: () => mocks.read(input),
	}),
}));
vi.mock("@/components/repository-shared-candidate-editor", () => ({
	RepositorySharedCandidate: () => {
		const [id] = useState(() => ++mocks.candidateMounts);
		return <span data-candidate-instance={id} />;
	},
}));
vi.mock("@/components/work-attempt-repository-panel", () => ({
	WorkAttemptRepositoryPanel: ({ attemptId }: { attemptId: string }) => (
		<div data-active-snapshot={attemptId}>Pinned active snapshot</div>
	),
}));
import { WorkRepositoryReview } from "./work-repository-review";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
let client: QueryClient;
const work = "11111111-1111-4111-8111-111111111111",
	attemptId = "22222222-2222-4222-8222-222222222222",
	admission = "33333333-3333-4333-8333-333333333333";
const base = "a".repeat(40),
	head = "b".repeat(40);
function attempt() {
	return {
		id: attemptId,
		finishedAt: "2026-11-03T17:00:00.000Z",
		metadata: {
			repository: {
				version: 1,
				provider: "cloudflare_artifacts",
				status: "ready",
				mode: "fork",
				repositoryName: `work-11111111-${attemptId}`,
				repositoryId: "repo-1",
				remote: "https://example.test/repo.git",
				defaultBranch: "main",
				sourceRepositoryName: "source",
				sourceRef: "main",
				baseRevision: base,
				workItemId: work,
				workItemVersion: 1,
				admissionSpecRevision: "spec-1",
				admissionId: admission,
				attemptId,
				observedAt: "2026-11-03T16:00:00.000Z",
				reason: null,
			},
			repositoryLifecycle: {
				version: 1,
				headRevision: head,
				review: { status: "not_reviewed", evidenceRef: null, reviewedAt: null },
				merge: {
					status: "not_merged",
					canonicalLedger: null,
					repository: null,
					commitSha: null,
					mergedAt: null,
				},
				deployment: {
					status: "not_deployed",
					surface: null,
					revision: null,
					evidenceRef: null,
					observedAt: null,
				},
			},
		},
	};
}
async function mount(value = attempt()) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	await act(async () =>
		root!.render(
			<QueryClientProvider client={client}>
				<WorkRepositoryReview workItemId={work} attempt={value} />
			</QueryClientProvider>,
		),
	);
}
async function click(label: string) {
	const button = await vi.waitFor(() => {
		const element = [...host.querySelectorAll("button")].find((candidate) =>
			candidate.textContent?.includes(label),
		);
		expect(element).toBeTruthy();
		return element!;
	});
	await act(async () => {
		button.click();
	});
}
afterEach(async () => {
	if (root) await act(async () => root!.unmount());
	root = undefined;
	host?.remove();
	client?.clear();
	vi.clearAllMocks();
	mocks.authority.role = "owner";
	vi.useRealTimers();
});
describe("retained repository result", () => {
	it("waits for deferred repository and comparison results before using them", async () => {
		const tree = Promise.withResolvers<unknown>();
		const comparison = Promise.withResolvers<unknown>();
		mocks.read.mockImplementation((input) =>
			input.operation === "compare" ? comparison.promise : tree.promise,
		);
		await mount();
		expect(mocks.read).not.toHaveBeenCalled();
		await click("Review repository result");
		expect(host.textContent).toContain("Loading repository result");
		let clicked = false;
		const selected = click("file.ts").then(
			() => {
				clicked = true;
				return null;
			},
			(error) => error,
		);
		await Promise.resolve();
		expect(clicked).toBe(false);
		await act(async () =>
			tree.resolve({
				entries: [
					{ name: "file.ts", type: "blob", hash: head, change: "modified" },
				],
				commits: [],
				truncated: false,
				nextOffset: null,
			}),
		);
		expect(await selected).toBeNull();
		expect(mocks.read).toHaveBeenCalledWith(
			expect.objectContaining({
				expectedHeadRevision: head,
				operation: "compare",
				path: "file.ts",
			}),
		);
		expect(host.textContent).toContain("Loading comparison");
		await act(async () =>
			comparison.resolve({
				base: { status: "text", text: "deferred before", bytes: 15 },
				head: { status: "text", text: "deferred after", bytes: 14 },
			}),
		);
		await vi.waitFor(() => {
			expect(host.textContent).toContain("deferred before");
			expect(host.textContent).toContain("deferred after");
		});
	});
	it("loads only on request and compares pinned content after an Attempt finishes", async () => {
		mocks.read.mockImplementation(async (input) => ({
			...input,
			workItemId: work,
			headRevision: head,
			baseRevision: base,
			entries: [
				{ name: "file.ts", type: "blob", hash: head, change: "modified" },
			],
			commits: [],
			truncated: false,
			nextOffset: null,
			base: { status: "text", text: "before", bytes: 6 },
			head: { status: "text", text: "after", bytes: 5 },
		}));
		await mount();
		expect(mocks.read).not.toHaveBeenCalled();
		await click("Review repository result");
		const trigger = [...host.querySelectorAll("button")].find((candidate) =>
			candidate.textContent?.includes("Hide repository result"),
		);
		const panelId = trigger?.getAttribute("aria-controls");
		expect(trigger?.getAttribute("data-kumo-component")).toBe(
			"CollapsibleTrigger",
		);
		expect(trigger?.getAttribute("aria-expanded")).toBe("true");
		expect(panelId).toBeTruthy();
		expect(host.querySelector(`#${panelId}`)?.hasAttribute("hidden")).toBe(
			false,
		);
		expect(host.textContent).toContain(head);
		await click("file.ts");
		expect(mocks.read).toHaveBeenCalledWith(
			expect.objectContaining({
				expectedHeadRevision: head,
				operation: "compare",
				path: "file.ts",
			}),
		);
		await vi.waitFor(() => {
			expect(host.textContent).toContain("before");
			expect(host.textContent).toContain("after");
		});
	});
	it("uses only the active snapshot browser before settlement", async () => {
		const value = attempt();
		value.finishedAt = "";
		await mount(value);
		expect(host.querySelectorAll("[data-active-snapshot]")).toHaveLength(1);
		expect(host.textContent).not.toContain("Review repository result");
		expect(mocks.read).not.toHaveBeenCalled();
	});

	it("keeps the same candidate editor mounted when its Attempt settles", async () => {
		mocks.candidateMounts = 0;
		const value = attempt();
		value.finishedAt = "";
		await mount(value);
		const instance = host.querySelector("[data-candidate-instance]");
		value.finishedAt = "2026-11-03T17:00:00.000Z";
		await act(async () =>
			root!.render(
				<QueryClientProvider client={client}>
					<WorkRepositoryReview workItemId={work} attempt={value} />
				</QueryClientProvider>,
			),
		);
		expect(host.querySelector("[data-candidate-instance]")).toBe(instance);
		expect(mocks.candidateMounts).toBe(1);
	});

	it("does not refetch retained repository tree or comparison while verification is paused", async () => {
		vi.useFakeTimers();
		mocks.read.mockResolvedValue({
			entries: [
				{ name: "file.ts", type: "blob", hash: head, change: "modified" },
			],
			commits: [],
			truncated: false,
			nextOffset: null,
			base: { status: "text", text: "before", bytes: 6 },
			head: { status: "text", text: "after", bytes: 5 },
		});
		host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
		client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const value = attempt();
		const render = (paused: boolean) =>
			root!.render(
				<QueryClientProvider client={client}>
					<WorkspaceVerificationPausedContext.Provider value={paused}>
						<WorkRepositoryReview workItemId={work} attempt={value} />
					</WorkspaceVerificationPausedContext.Provider>
				</QueryClientProvider>,
			);
		await act(async () => render(false));
		await click("Review repository result");
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1);
		});
		await click("file.ts");
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1);
		});
		const calls = mocks.read.mock.calls.length;
		expect(calls).toBe(2);
		await act(async () => {
			render(true);
		});
		await act(async () => {
			await client.invalidateQueries();
			await vi.advanceTimersByTimeAsync(1);
		});
		expect(mocks.read).toHaveBeenCalledTimes(calls);
		expect(host.textContent).toContain("after");
		await act(async () => {
			render(false);
			await vi.advanceTimersByTimeAsync(1);
		});
		expect(mocks.read.mock.calls.length).toBeGreaterThan(calls);
	});

	it("shows unavailable without an immutable head receipt and never queries HEAD", async () => {
		const value = attempt();
		delete (value.metadata as Record<string, unknown>).repositoryLifecycle;
		await mount(value);
		expect(host.textContent).toContain("no immutable result receipt");
		expect(mocks.read).not.toHaveBeenCalled();
	});
	it("does not expose retained source to use-only members", async () => {
		mocks.authority.role = "member";
		await mount();
		expect(host.textContent).toBe("");
		expect(mocks.read).not.toHaveBeenCalled();
	});
});
