import { useWorkspaceVerificationPaused } from "@/lib/workspace-verification";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useId, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({
	work: vi.fn(),
	attempts: vi.fn(),
	authority: { role: "owner", permissions: ["secrets:manage"] },
}));
vi.mock("@/lib/use-os-preferences", () => ({
	useOsOperationalContext: () => ({
		data: { authority: mocks.authority },
		isError: false,
	}),
}));
vi.mock("@/components/work-repository-review", () => ({
	WorkRepositoryReview: ({
		workItemId,
		attempt,
	}: {
		workItemId: string;
		attempt: { id: string };
	}) => {
		const id = useId(),
			paused = useWorkspaceVerificationPaused();
		const [files, setFiles] = useState("first|second");
		return (
			<div
				data-work={workItemId}
				data-attempt={attempt.id}
				data-instance={id}
				data-paused={paused}
			>
				Canonical repository review
				<button onClick={() => setFiles("unsynced first|unsynced second")}>
					Type
				</button>
				{files}
			</div>
		);
	},
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
	vi.useRealTimers();
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

it("preserves an open repository and its local text through a background Work verification failure", async () => {
	vi.useFakeTimers();
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	await act(async () => {
		root.render(
			<QueryClientProvider client={client}>
				<CanvasRepositoryWorkpiece
					workspaceId={workspace}
					workItemId={work}
					attemptId={attempt}
				/>
			</QueryClientProvider>,
		);
		await vi.advanceTimersByTimeAsync(1);
	});
	await act(async () => {
		await vi.advanceTimersByTimeAsync(1);
	});
	const review = host.querySelector("[data-work]");
	expect(review).not.toBeNull();
	act(() => host.querySelector("button")!.click());
	mocks.work.mockRejectedValue({ code: "INTERNAL_SERVER_ERROR" });
	await act(async () => {
		await client.invalidateQueries();
		await vi.advanceTimersByTimeAsync(1);
	});
	expect(host.querySelector("[data-work]")).toBe(review);
	expect(review?.getAttribute("data-paused")).toBe("true");
	expect(host.textContent).toContain("unsynced first|unsynced second");
	mocks.work.mockResolvedValue({
		workItem: {
			id: work,
			title: "Coding Work",
			provenance: { workspaceId: workspace },
		},
	});
	await act(async () => {
		await client.invalidateQueries();
		await vi.advanceTimersByTimeAsync(1);
	});
	expect(host.querySelector("[data-work]")).toBe(review);
	expect(review?.getAttribute("data-paused")).toBe("false");
	mocks.work.mockRejectedValue({ code: "FORBIDDEN" });
	await act(async () => {
		await client.invalidateQueries();
		await vi.advanceTimersByTimeAsync(1);
	});
	expect(host.querySelector("[data-work]")).toBeNull();
});
