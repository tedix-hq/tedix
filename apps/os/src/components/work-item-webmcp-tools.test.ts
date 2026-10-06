import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { buildWorkItemWebMcpTools } from "@/components/work-item-webmcp-tools";
import { osApi } from "@/lib/api";
import { workItemDetailQueryOptions } from "@/lib/os-query-options";
import type { ModelContextLike } from "@tedix/webmcp-core/model-context";
import {
	registerWebMcpScope,
	setModelContextResolverForTests,
	webMcpRegisteredToolNames,
} from "@tedix/webmcp-core/registry";

vi.mock("@/lib/api", () => ({
	osApi: {
		workItems: {
			getById: vi.fn(),
			getReadiness: vi.fn(),
			addComment: vi.fn(),
			listEvidence: vi.fn(),
			listEvents: vi.fn(),
			listAttempts: vi.fn(),
			// Not called by the tools; present so the generated query-key
			// utilities in os-query-options can wrap it for key derivation.
			listReadinessProjection: vi.fn(),
		},
	},
}));

const workItemsApi = osApi.workItems as unknown as {
	getById: ReturnType<typeof vi.fn>;
	getReadiness: ReturnType<typeof vi.fn>;
	addComment: ReturnType<typeof vi.fn>;
	listEvidence: ReturnType<typeof vi.fn>;
	listEvents: ReturnType<typeof vi.fn>;
	listAttempts: ReturnType<typeof vi.fn>;
};

const ITEM_ID = "6f4d2f66-90f9-4a53-b6a4-a2b1c9d0e1f2";
const DEEP_LINK = `/work/items/${ITEM_ID}`;

function makeDeps() {
	const queryClient = new QueryClient();
	const invalidateQueries = vi
		.spyOn(queryClient, "invalidateQueries")
		.mockResolvedValue(undefined);
	return { queryClient, invalidateQueries };
}

function tools() {
	const { queryClient, invalidateQueries } = makeDeps();
	const built = buildWorkItemWebMcpTools(ITEM_ID, { queryClient });
	const byName = new Map(built.map((tool) => [tool.name, tool]));
	return { built, byName, invalidateQueries };
}

afterEach(() => {
	setModelContextResolverForTests(null);
	vi.clearAllMocks();
});

describe("buildWorkItemWebMcpTools", () => {
	it("marks item reads untrusted and item comments as writes", () => {
		const { byName } = tools();
		expect(byName.get("get_current_work_item")?.annotations).toEqual({
			readOnlyHint: true,
			untrustedContentHint: true,
		});
		expect(byName.get("comment_current_work_item")?.annotations).toEqual({
			readOnlyHint: false,
			untrustedContentHint: false,
		});
	});

	it("registers the five item-scoped tools under an id-keyed scope", () => {
		const context: ModelContextLike = {
			provideContext: () => {},
		};
		setModelContextResolverForTests(() => context);

		const { queryClient } = makeDeps();
		const dispose = registerWebMcpScope(
			`work-item:${ITEM_ID}`,
			buildWorkItemWebMcpTools(ITEM_ID, { queryClient }),
		);
		expect(webMcpRegisteredToolNames()).toEqual([
			"get_current_work_item",
			"comment_current_work_item",
			"list_current_work_item_evidence",
			"list_current_work_item_events",
			"list_current_work_item_attempts",
		]);
		dispose();
	});

	it("get_current_work_item composes the detail with the readiness verdict", async () => {
		workItemsApi.getById.mockResolvedValue({
			workItem: {
				id: ITEM_ID,
				title: "Ship the thing",
				disposition: "accepted",
				workKind: "coding",
				workClass: "objective",
				acceptanceContract: {
					version: 1,
					doneLooksLike: "It is deployed",
				},
			},
			comments: [
				{
					id: "c1",
					authorType: "user",
					body: "Looks good",
					createdAt: "2026-08-26T00:00:00Z",
				},
			],
			projections: [],
		});
		workItemsApi.getReadiness.mockResolvedValue({
			workItemId: ITEM_ID,
			state: "approval_blocked",
			ready: false,
			reasons: [
				{ code: "approval_blocked", detail: "Awaiting human approval" },
			],
			derivedAt: "2026-08-26T00:00:00Z",
			gates: [],
		});
		const { byName } = tools();
		const result = await byName.get("get_current_work_item")!.execute({});
		expect(workItemsApi.getById).toHaveBeenCalledWith({ id: ITEM_ID });
		expect(workItemsApi.getReadiness).toHaveBeenCalledWith({ id: ITEM_ID });
		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toEqual({
			id: ITEM_ID,
			title: "Ship the thing",
			disposition: "accepted",
			workKind: "coding",
			workClass: "objective",
			doneLooksLike: "It is deployed",
			readiness: {
				state: "approval_blocked",
				ready: false,
				reasons: [
					{ code: "approval_blocked", detail: "Awaiting human approval" },
				],
			},
			commentsCount: 1,
			latestComments: [
				{
					authorType: "user",
					body: "Looks good",
					createdAt: "2026-08-26T00:00:00Z",
				},
			],
			deepLink: DEEP_LINK,
		});
	});

	it("comment_current_work_item posts to the bound item and invalidates its detail", async () => {
		workItemsApi.addComment.mockResolvedValue({ id: "c9" });
		const { byName, invalidateQueries } = tools();
		const result = await byName
			.get("comment_current_work_item")!
			.execute({ body: "On it" });
		expect(workItemsApi.addComment).toHaveBeenCalledWith({
			id: ITEM_ID,
			body: "On it",
		});
		expect(result.structuredContent).toEqual({
			commentId: "c9",
			workItemId: ITEM_ID,
			deepLink: DEEP_LINK,
		});
		expect(invalidateQueries).toHaveBeenCalledWith({
			queryKey: workItemDetailQueryOptions(ITEM_ID).queryKey,
		});
	});

	it("comment_current_work_item rejects a missing body without calling the API", async () => {
		const { byName, invalidateQueries } = tools();
		const result = await byName.get("comment_current_work_item")!.execute({});
		expect(result.isError).toBe(true);
		expect(workItemsApi.addComment).not.toHaveBeenCalled();
		expect(invalidateQueries).not.toHaveBeenCalled();
	});

	it("list_current_work_item_evidence maps ledger rows", async () => {
		workItemsApi.listEvidence.mockResolvedValue({
			data: [
				{
					id: "e1",
					claimKey: "deployed",
					kind: "deployment",
					uri: "https://example.com/deploy/1",
					disposition: "accepted",
					submittedByType: "tedi",
					submittedById: "cto",
					reviewedByType: "user",
					reviewedById: "U_reviewer",
					reviewReason: "Verified live",
					metadata: {},
				},
			],
			nextCursor: null,
		});
		const { byName } = tools();
		const result = await byName
			.get("list_current_work_item_evidence")!
			.execute({});
		expect(workItemsApi.listEvidence).toHaveBeenCalledWith({
			id: ITEM_ID,
			limit: 50,
		});
		expect(result.structuredContent).toEqual({
			evidence: [
				{
					id: "e1",
					claimKey: "deployed",
					kind: "deployment",
					uri: "https://example.com/deploy/1",
					disposition: "accepted",
					submittedByType: "tedi",
					submittedById: "cto",
					reviewedByType: "user",
					reviewedById: "U_reviewer",
					reviewReason: "Verified live",
				},
			],
			deepLink: DEEP_LINK,
		});
	});

	it("list_current_work_item_events maps rows with a trimmed payload summary", async () => {
		workItemsApi.listEvents.mockResolvedValue({
			events: [
				{
					sequence: 7,
					id: "ev1",
					eventType: "attempt_started",
					actorType: "tedi",
					actorId: "cto",
					occurredAt: "2026-08-26T00:00:00Z",
					payload: { note: "x".repeat(400) },
				},
			],
			nextSequence: 8,
		});
		const { byName } = tools();
		const result = await byName
			.get("list_current_work_item_events")!
			.execute({});
		expect(workItemsApi.listEvents).toHaveBeenCalledWith({
			id: ITEM_ID,
			limit: 100,
		});
		const structured = result.structuredContent as {
			events: Array<Record<string, unknown>>;
			nextSequence: number;
			deepLink: string;
		};
		expect(structured.nextSequence).toBe(8);
		expect(structured.deepLink).toBe(DEEP_LINK);
		expect(structured.events[0]).toMatchObject({
			sequence: 7,
			eventType: "attempt_started",
			actorType: "tedi",
			actorId: "cto",
			occurredAt: "2026-08-26T00:00:00Z",
		});
		const summary = structured.events[0]?.["payloadSummary"] as string;
		expect(summary.length).toBeLessThanOrEqual(201);
		expect(summary.endsWith("…")).toBe(true);
	});

	it("list_current_work_item_attempts maps attempt rows", async () => {
		workItemsApi.listAttempts.mockResolvedValue({
			data: [
				{
					id: "a1",
					executorType: "tedi",
					executorId: "cto",
					runtimeState: "finished",
					outcome: "succeeded",
					attemptNumber: 1,
					startedAt: "2026-08-26T00:00:00Z",
					heartbeatAt: "2026-08-26T00:55:00Z",
					expiresAt: null,
					finishedAt: "2026-08-26T01:00:00Z",
					summary: "Shipped",
					metadata: {},
				},
			],
			nextCursor: null,
		});
		const { byName } = tools();
		const result = await byName
			.get("list_current_work_item_attempts")!
			.execute({});
		expect(workItemsApi.listAttempts).toHaveBeenCalledWith({
			id: ITEM_ID,
			limit: 50,
		});
		expect(result.structuredContent).toEqual({
			attempts: [
				{
					id: "a1",
					executorType: "tedi",
					executorId: "cto",
					runtimeState: "finished",
					outcome: "succeeded",
					attemptNumber: 1,
					startedAt: "2026-08-26T00:00:00Z",
					heartbeatAt: "2026-08-26T00:55:00Z",
					expiresAt: null,
					finishedAt: "2026-08-26T01:00:00Z",
					summary: "Shipped",
				},
			],
			nextCursor: null,
			hasMore: false,
			deepLink: DEEP_LINK,
		});
	});

	it("preserves missed updates and passes the continuation cursor for earlier attempts", async () => {
		const cursor = {
			at: "2026-08-26T00:00:00Z",
			id: "6f4d2f66-90f9-4a53-b6a4-a2b1c9d0e1f3",
		};
		workItemsApi.listAttempts.mockResolvedValue({
			data: [
				{
					id: "a1",
					runtimeState: "running",
					outcome: null,
					heartbeatAt: "2026-08-25T00:00:00Z",
					expiresAt: "2026-08-25T00:05:00Z",
					finishedAt: null,
				},
			],
			nextCursor: cursor,
		});
		const { byName } = tools();
		const result = await byName
			.get("list_current_work_item_attempts")!
			.execute({ cursor });
		expect(workItemsApi.listAttempts).toHaveBeenCalledWith({
			id: ITEM_ID,
			limit: 50,
			cursor,
		});
		expect(result.structuredContent).toMatchObject({
			attempts: [
				{
					runtimeState: "running",
					heartbeatAt: "2026-08-25T00:00:00Z",
					expiresAt: "2026-08-25T00:05:00Z",
				},
			],
			nextCursor: cursor,
			hasMore: true,
		});
	});

	it("rejects malformed continuation cursors without an API call", async () => {
		const { byName } = tools();
		const result = await byName
			.get("list_current_work_item_attempts")!
			.execute({ cursor: { at: "yesterday", id: "not-a-uuid" } });
		expect(result.isError).toBe(true);
		expect(workItemsApi.listAttempts).not.toHaveBeenCalled();
	});

	it("surfaces an osApi rejection as an isError result, not a throw", async () => {
		workItemsApi.getById.mockRejectedValue(new Error("boom: not found"));
		workItemsApi.getReadiness.mockResolvedValue({
			workItemId: ITEM_ID,
			state: "ready",
			ready: true,
			reasons: [],
			derivedAt: "2026-08-26T00:00:00Z",
			gates: [],
		});
		const { byName } = tools();
		const result = await byName.get("get_current_work_item")!.execute({});
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("boom");
	});
});

describe("WebMCP execution cancellation", () => {
	it("forwards the browser AbortSignal to bound Work reads", async () => {
		const controller = new AbortController();
		const { byName } = tools();
		await byName
			.get("list_current_work_item_evidence")!
			.execute({}, { signal: controller.signal });
		expect(workItemsApi.listEvidence).toHaveBeenCalledWith(
			{ id: ITEM_ID, limit: 50 },
			{ signal: controller.signal },
		);
	});
});
