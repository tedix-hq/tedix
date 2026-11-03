import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
	read: vi.fn(),
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
	const button = [...host.querySelectorAll("button")].find((element) =>
		element.textContent?.includes(label),
	);
	expect(button).toBeTruthy();
	await act(async () => {
		button!.click();
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
}
afterEach(async () => {
	if (root) await act(async () => root!.unmount());
	root = undefined;
	host?.remove();
	client?.clear();
	vi.clearAllMocks();
	mocks.authority.role = "owner";
});
describe("retained repository result", () => {
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
		expect(host.textContent).toContain(head);
		await click("file.ts");
		expect(mocks.read).toHaveBeenCalledWith(
			expect.objectContaining({
				expectedHeadRevision: head,
				operation: "compare",
				path: "file.ts",
			}),
		);
		expect(host.textContent).toContain("before");
		expect(host.textContent).toContain("after");
	});
	it("uses only the active snapshot browser before settlement", async () => {
		const value = attempt();
		value.finishedAt = "";
		await mount(value);
		expect(host.querySelectorAll("[data-active-snapshot]")).toHaveLength(1);
		expect(host.textContent).not.toContain("Review repository result");
		expect(mocks.read).not.toHaveBeenCalled();
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
