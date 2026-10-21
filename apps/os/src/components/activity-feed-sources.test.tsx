import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
	WorkAttemptProjectionSchema,
	type WorkActivityEvent,
} from "@tedix/api-contract/schemas/work-items";
import {
	ActivityFeedSources,
	type FeedSourceState,
} from "./activity-feed-sources";

const api = vi.hoisted(() => ({
	listActivity: vi.fn(),
	listAttemptProjection: vi.fn(),
	getContext: vi.fn(),
	names: new Map<string, string>(),
}));
vi.mock("@/lib/api", () => ({
	osApi: {
		workItems: {
			listActivity: api.listActivity,
			listAttemptProjection: api.listAttemptProjection,
		},
		userSettings: { getContext: api.getContext },
	},
}));
vi.mock("@/components/work-operations-shared", () => ({
	useWorkPrincipalNames: () => api.names,
}));

const projectId = "11111111-1111-4111-8111-111111111111";
const workId = "22222222-2222-4222-8222-222222222222";
const at = "2026-10-20T12:00:00.000Z";
const workCursor = { at, id: "33333333-3333-4333-8333-333333333333" };
const resultCursor = {
	at: "2026-10-19T12:00:00.000Z",
	id: "44444444-4444-4444-8444-444444444444",
};
type Cursor = typeof workCursor | null;

function workPage(id: string, nextCursor: Cursor = null) {
	const event: WorkActivityEvent = {
		id,
		workItemId: workId,
		workItemTitle: "Prepare Cedar's brief",
		workItemDisposition: "accepted",
		eventType: "work.updated",
		authorType: "user",
		authorId: "cedar",
		agentSession: null,
		agentHarness: null,
		settlement: null,
		body: "Updated the brief.",
		createdAt: at,
	};
	return { events: [event], nextCursor };
}

function resultPage(id: string, nextCursor: Cursor = null) {
	const row = WorkAttemptProjectionSchema.parse({
		attempt: {
			id,
			orgId: "55555555-5555-4555-8555-555555555555",
			workItemId: workId,
			executorType: "external_agent",
			executorId: "cedar-agent",
			executorSessionId: null,
			externalSessionKey: null,
			runtimeState: "finished",
			outcome: "succeeded",
			runId: null,
			admissionId: null,
			attemptNumber: 1,
			startedAt: at,
			heartbeatAt: at,
			expiresAt: null,
			finishedAt: at,
			summary: "Prepared the brief.",
			metadata: {},
		},
		workItem: {
			id: workId,
			title: "Prepare Cedar's brief",
			disposition: "accepted",
			workKind: "coding",
			riskLevel: "low",
			priority: "medium",
			projectId,
			accountableOwnerType: null,
			accountableOwnerId: null,
		},
	});
	return { data: [row], nextCursor };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}

async function flush() {
	await act(async () => {
		for (let tick = 0; tick < 5; tick++) await vi.advanceTimersByTimeAsync(1);
	});
}

let close: (() => Promise<void>) | undefined;
beforeEach(() => {
	vi.useFakeTimers();
	api.listActivity.mockReset();
	api.listAttemptProjection.mockReset();
	api.getContext
		.mockReset()
		.mockResolvedValue({ organization: { id: "cedar" } });
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal(
		"fetch",
		vi.fn().mockRejectedValue(new Error("Unexpected network access")),
	);
});
afterEach(async () => {
	await close?.();
	close = undefined;
	expect(fetch).not.toHaveBeenCalled();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

async function mount(scope?: string) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const onUpdate = vi.fn<(scope: string, state: FeedSourceState) => void>();
	close = async () => {
		await act(async () => root.unmount());
		client.clear();
		host.remove();
	};
	const render = async (request: number) => {
		await act(async () => {
			root.render(
				<QueryClientProvider client={client}>
					<ActivityFeedSources
						projectId={scope}
						pageSize={2}
						request={request}
						onUpdate={onUpdate}
					/>
				</QueryClientProvider>,
			);
		});
		await flush();
	};
	await render(0);
	return {
		render,
		onUpdate,
		state: () => onUpdate.mock.calls.at(-1)![1],
		ids: () => onUpdate.mock.calls.at(-1)![1].items.map((item) => item.id),
	};
}

const resultId = "66666666-6666-4666-8666-666666666666";
const nextResultId = "77777777-7777-4777-8777-777777777777";

it.each([
	{ scope: undefined, first: "work" },
	{ scope: projectId, first: "results" },
])(
	"keeps independent cursors and loaded pages when $first resolves first (scope $scope)",
	async ({ scope, first }) => {
		const work = deferred<ReturnType<typeof workPage>>();
		const results = deferred<ReturnType<typeof resultPage>>();
		const nextWork = deferred<ReturnType<typeof workPage>>();
		const nextResults = deferred<ReturnType<typeof resultPage>>();
		api.listActivity
			.mockReturnValueOnce(work.promise)
			.mockReturnValueOnce(nextWork.promise);
		api.listAttemptProjection
			.mockReturnValueOnce(results.promise)
			.mockReturnValueOnce(nextResults.promise);
		const view = await mount(scope);
		expect(view.state()).toMatchObject({
			loading: true,
			failed: false,
			more: false,
		});
		if (first === "work") work.resolve(workPage("first", workCursor));
		else results.resolve(resultPage(resultId, resultCursor));
		await flush();
		expect(view.ids()).toEqual([
			first === "work" ? "work:first" : `attempt:${resultId}`,
		]);
		expect(view.state()).toMatchObject({
			loading: true,
			failed: false,
			more: true,
		});
		if (first === "work") results.resolve(resultPage(resultId, resultCursor));
		else work.resolve(workPage("first", workCursor));
		await flush();
		expect(view.ids()).toEqual(["work:first", `attempt:${resultId}`]);
		expect(view.onUpdate.mock.calls.at(-1)![0]).toBe(scope ?? "organization");
		expect(
			view.state().items.find((item) => item.id === "work:first")?.projectId,
		).toBe(scope ?? null);
		await view.render(0);
		expect(api.listActivity).toHaveBeenCalledTimes(1);
		expect(api.listAttemptProjection).toHaveBeenCalledTimes(1);
		await view.render(1);
		expect(api.listActivity.mock.calls.map(([input]) => input)).toEqual([
			{ projectId: scope, limit: 2, cursor: undefined },
			{ projectId: scope, limit: 2, cursor: workCursor },
		]);
		expect(
			api.listAttemptProjection.mock.calls.map(([input]) => input),
		).toEqual([
			{
				projectId: scope,
				limit: 2,
				cursor: undefined,
				outcomes: ["succeeded", "failed", "expired", "cancelled"],
			},
			{
				projectId: scope,
				limit: 2,
				cursor: resultCursor,
				outcomes: ["succeeded", "failed", "expired", "cancelled"],
			},
		]);
		// A new request while both sources are busy must not cancel or duplicate either read.
		await view.render(2);
		expect(api.listActivity).toHaveBeenCalledTimes(2);
		expect(api.listAttemptProjection).toHaveBeenCalledTimes(2);
		nextResults.resolve(resultPage(nextResultId));
		await flush();
		expect(view.ids()).toEqual([
			"work:first",
			`attempt:${resultId}`,
			`attempt:${nextResultId}`,
		]);
		expect(view.state().loading).toBe(true);
		nextWork.resolve(workPage("second"));
		await flush();
		expect(view.ids()).toEqual([
			"work:first",
			"work:second",
			`attempt:${resultId}`,
			`attempt:${nextResultId}`,
		]);
		expect(view.state()).toMatchObject({
			loading: false,
			failed: false,
			more: false,
		});
		await view.render(2);
		await view.render(3);
		expect(api.listActivity).toHaveBeenCalledTimes(2);
		expect(api.listAttemptProjection).toHaveBeenCalledTimes(2);
	},
);

it.each(["work", "results"] as const)(
	"recovers an initial %s failure only on an explicit request",
	async (failedSource) => {
		const failure = Object.assign(new Error("Source unavailable"), {
			code: "FORBIDDEN",
		});
		api.listActivity.mockResolvedValue(workPage("first"));
		api.listAttemptProjection.mockResolvedValue(resultPage(resultId));
		const failed =
			failedSource === "work" ? api.listActivity : api.listAttemptProjection;
		const healthy =
			failedSource === "work" ? api.listAttemptProjection : api.listActivity;
		failed.mockRejectedValueOnce(failure);
		const view = await mount();
		expect(view.state()).toMatchObject({
			loading: false,
			failed: true,
			more: false,
		});
		expect(view.ids()).toEqual([
			failedSource === "work" ? `attempt:${resultId}` : "work:first",
		]);
		await view.render(0);
		expect(failed).toHaveBeenCalledTimes(1);
		await view.render(1);
		expect(view.state()).toMatchObject({
			loading: false,
			failed: false,
			more: false,
		});
		expect(view.ids()).toEqual(["work:first", `attempt:${resultId}`]);
		expect(failed.mock.calls.map(([input]) => input.cursor)).toEqual([
			undefined,
			undefined,
		]);
		expect(healthy).toHaveBeenCalledTimes(1);
	},
);

it("retains both sources' loaded pages after a pagination failure and recovers the failed source", async () => {
	api.listActivity
		.mockResolvedValueOnce(workPage("first", workCursor))
		.mockResolvedValueOnce(workPage("second"));
	api.listAttemptProjection
		.mockResolvedValueOnce(resultPage(resultId, resultCursor))
		.mockRejectedValueOnce(
			Object.assign(new Error("Page unavailable"), { code: "FORBIDDEN" }),
		)
		.mockResolvedValueOnce(resultPage(resultId, resultCursor))
		.mockResolvedValueOnce(resultPage(nextResultId));
	const view = await mount(projectId);
	await view.render(1);
	expect(view.ids()).toEqual([
		"work:first",
		"work:second",
		`attempt:${resultId}`,
	]);
	expect(view.state()).toMatchObject({
		loading: false,
		failed: true,
		more: true,
	});
	await view.render(1);
	expect(api.listAttemptProjection).toHaveBeenCalledTimes(2);
	await view.render(2);
	expect(view.ids()).toEqual([
		"work:first",
		"work:second",
		`attempt:${resultId}`,
	]);
	expect(view.state()).toMatchObject({
		loading: false,
		failed: false,
		more: true,
	});
	// Refetch repairs the loaded page; a later request resumes its canonical next cursor.
	await view.render(3);
	expect(view.ids()).toEqual([
		"work:first",
		"work:second",
		`attempt:${resultId}`,
		`attempt:${nextResultId}`,
	]);
	expect(view.state()).toMatchObject({
		loading: false,
		failed: false,
		more: false,
	});
	expect(
		api.listAttemptProjection.mock.calls.map(([input]) => input.cursor),
	).toEqual([undefined, resultCursor, undefined, resultCursor]);
	expect(api.listActivity).toHaveBeenCalledTimes(2);
});

it("advances a ready source while the other source is still busy", async () => {
	const work = deferred<ReturnType<typeof workPage>>();
	api.listActivity.mockReturnValueOnce(work.promise);
	api.listAttemptProjection
		.mockResolvedValueOnce(resultPage(resultId, resultCursor))
		.mockResolvedValueOnce(resultPage(nextResultId));
	const view = await mount();
	expect(view.state()).toMatchObject({ loading: true, more: true });
	await view.render(1);
	expect(api.listActivity).toHaveBeenCalledTimes(1);
	expect(api.listAttemptProjection).toHaveBeenCalledTimes(2);
	expect(api.listAttemptProjection.mock.calls[1]![0].cursor).toEqual(
		resultCursor,
	);
	expect(view.ids()).toEqual([
		`attempt:${resultId}`,
		`attempt:${nextResultId}`,
	]);
	expect(view.state()).toMatchObject({
		loading: true,
		failed: false,
		more: false,
	});
	work.resolve(workPage("first"));
	await flush();
	expect(view.ids()).toEqual([
		"work:first",
		`attempt:${resultId}`,
		`attempt:${nextResultId}`,
	]);
	expect(view.state()).toMatchObject({
		loading: false,
		failed: false,
		more: false,
	});
	await view.render(1);
	expect(api.listActivity).toHaveBeenCalledTimes(1);
	expect(api.listAttemptProjection).toHaveBeenCalledTimes(2);
});
