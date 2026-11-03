import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({
	work: vi.fn(),
	attempts: vi.fn(),
	authority: { role: "owner", permissions: ["secrets:manage"] },
}));
vi.mock("@/lib/use-os-preferences", () => ({
	useOsOperationalContext: () => ({ data: { authority: mocks.authority } }),
}));
vi.mock("@/components/work-repository-review", () => ({
	WorkRepositoryReview: ({
		workItemId,
		attempt,
	}: {
		workItemId: string;
		attempt: { id: string };
	}) => (
		<div data-work={workItemId} data-attempt={attempt.id}>
			Canonical repository review
		</div>
	),
}));
vi.mock("@/lib/os-query-options", () => ({
	workItemDetailQueryOptions: (id: string) => ({
		queryKey: ["canvas-repo-work-test", id],
		queryFn: () => mocks.work(id),
	}),
	osQuery: {
		workItems: {
			listAttempts: {
				infiniteOptions: (options: {
					input: (cursor: unknown) => unknown;
					initialPageParam: unknown;
					getNextPageParam: (page: unknown) => unknown;
				}) => ({
					queryKey: ["canvas-repo-attempt-test"],
					initialPageParam: options.initialPageParam,
					getNextPageParam: options.getNextPageParam,
					queryFn: ({ pageParam }: { pageParam: unknown }) =>
						mocks.attempts(options.input(pageParam)),
				}),
			},
		},
	},
}));
import { CanvasRepositoryWorkpiece } from "./canvas-repository-workpiece";
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const workspace = "11111111-1111-4111-8111-111111111111",
	work = "22222222-2222-4222-8222-222222222222",
	attempt = "33333333-3333-4333-8333-333333333333";
let host: HTMLDivElement,
	root: ReturnType<typeof createRoot>,
	client: QueryClient;
async function flush() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 25));
	});
}
async function mount() {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<CanvasRepositoryWorkpiece
					workspaceId={workspace}
					workItemId={work}
					attemptId={attempt}
				/>
			</QueryClientProvider>,
		),
	);
	await flush();
	await flush();
}
beforeEach(() => {
	mocks.authority.role = "owner";
	mocks.authority.permissions = ["secrets:manage"];
	mocks.work.mockReset().mockResolvedValue({
		workItem: {
			id: work,
			title: "Existing coding Work",
			provenance: { workspaceId: workspace },
		},
	});
	mocks.attempts
		.mockReset()
		.mockResolvedValue({ data: [{ id: attempt }], nextCursor: null });
});
afterEach(async () => {
	if (root) await act(async () => root.unmount());
	host?.remove();
	client?.clear();
});
it("reuses the existing Work review with exact Work and Attempt IDs", async () => {
	await mount();
	expect(host.querySelector("[data-work]")?.getAttribute("data-work")).toBe(
		work,
	);
	expect(
		host.querySelector("[data-attempt]")?.getAttribute("data-attempt"),
	).toBe(attempt);
	expect(mocks.attempts).toHaveBeenCalledWith({
		id: work,
		limit: 50,
		cursor: undefined,
	});
});
it.each(["member", "no-secrets"])(
	"does not read repository Work for %s access",
	async (role) => {
		if (role === "member") mocks.authority.role = "member";
		else mocks.authority.permissions = [];
		await mount();
		expect(mocks.work).not.toHaveBeenCalled();
		expect(mocks.attempts).not.toHaveBeenCalled();
		expect(host.textContent).toContain("secrets management");
	},
);
it("does not load Attempts when the Work belongs to another workspace", async () => {
	mocks.work.mockResolvedValue({
		workItem: { provenance: { workspaceId: "elsewhere" } },
	});
	await mount();
	expect(mocks.attempts).not.toHaveBeenCalled();
	expect(host.textContent).toContain("unavailable in this workspace");
});
it("does not substitute another Attempt when the exact session is absent", async () => {
	mocks.attempts.mockResolvedValue({
		data: [{ id: "other" }],
		nextCursor: null,
	});
	await mount();
	expect(host.querySelector("[data-attempt]")).toBeNull();
	expect(host.textContent).toContain("not recorded on this Work");
});
it("can find the exact session on an older bounded ledger page", async () => {
	const cursor = { at: "2026-11-01T00:00:00.000Z", id: "older" };
	mocks.attempts
		.mockResolvedValueOnce({ data: [], nextCursor: cursor })
		.mockResolvedValueOnce({ data: [{ id: attempt }], nextCursor: null });
	await mount();
	await act(async () => host.querySelector("button")!.click());
	await flush();
	expect(mocks.attempts).toHaveBeenLastCalledWith({
		id: work,
		limit: 50,
		cursor,
	});
	expect(
		host.querySelector("[data-attempt]")?.getAttribute("data-attempt"),
	).toBe(attempt);
});
