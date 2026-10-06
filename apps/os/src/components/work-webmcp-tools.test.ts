import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { buildWorkWebMcpTools } from "@/components/work-webmcp-tools";
import { osApi } from "@/lib/api";
import {
	osQuery,
	workItemDetailQueryOptions,
	workReadinessProjectionQueryOptions,
} from "@/lib/os-query-options";
import type { ModelContextLike } from "@tedix/webmcp-core/model-context";
import {
	registerWebMcpScope,
	setModelContextResolverForTests,
	webMcpRegisteredToolNames,
} from "@tedix/webmcp-core/registry";

vi.mock("@/lib/api", () => ({
	osApi: {
		workItems: {
			list: vi.fn(),
			getById: vi.fn(),
			create: vi.fn(),
			addComment: vi.fn(),
			// Not called by the tools; present so the generated query-key
			// utilities in os-query-options can wrap it for key derivation.
			listReadinessProjection: vi.fn(),
		},
		workApprovals: {
			listInbox: vi.fn(),
		},
	},
}));

const workItemsApi = osApi.workItems as unknown as {
	list: ReturnType<typeof vi.fn>;
	getById: ReturnType<typeof vi.fn>;
	create: ReturnType<typeof vi.fn>;
	addComment: ReturnType<typeof vi.fn>;
};

const workApprovalsApi = osApi.workApprovals as unknown as {
	listInbox: ReturnType<typeof vi.fn>;
};

function makeDeps() {
	const queryClient = new QueryClient();
	const invalidateQueries = vi
		.spyOn(queryClient, "invalidateQueries")
		.mockResolvedValue(undefined);
	return { queryClient, invalidateQueries };
}

function tools() {
	const { queryClient, invalidateQueries } = makeDeps();
	const built = buildWorkWebMcpTools({ queryClient });
	const byName = new Map(built.map((tool) => [tool.name, tool]));
	return { built, byName, invalidateQueries };
}

const ITEM_ID = "6f4d2f66-90f9-4a53-b6a4-a2b1c9d0e1f2";

const workItemRow = {
	id: ITEM_ID,
	title: "Ship the thing",
	disposition: "proposed",
	workKind: "coding",
	workClass: "objective",
	priority: "medium",
	riskLevel: "medium",
	description: null,
	projectId: null,
	objectiveId: null,
	acceptanceContract: null,
};

afterEach(() => {
	setModelContextResolverForTests(null);
	vi.clearAllMocks();
});

describe("buildWorkWebMcpTools", () => {
	it("classifies reads, writes, and untrusted tenant content", () => {
		const { byName } = tools();
		expect(byName.get("list_work_items")?.annotations).toEqual({
			readOnlyHint: true,
			untrustedContentHint: true,
		});
		expect(byName.get("create_work_item")?.annotations).toEqual({
			readOnlyHint: false,
			untrustedContentHint: false,
		});
	});

	it("registers the five work tools on the WebMCP surface", () => {
		const provided: string[][] = [];
		const context: ModelContextLike = {
			provideContext: ({ tools: t }) => provided.push(t.map((x) => x.name)),
		};
		setModelContextResolverForTests(() => context);

		const { queryClient } = makeDeps();
		const dispose = registerWebMcpScope(
			"work",
			buildWorkWebMcpTools({ queryClient }),
		);
		expect(webMcpRegisteredToolNames()).toEqual([
			"list_work_items",
			"get_work_item",
			"create_work_item",
			"comment_work_item",
			"list_pending_approvals",
		]);
		dispose();
	});

	it("list_work_items passes filters through and maps compact rows", async () => {
		workItemsApi.list.mockResolvedValue({
			data: [workItemRow],
			pagination: { limit: 10, hasMore: false },
		});
		const { byName } = tools();
		const result = await byName.get("list_work_items")!.execute({
			disposition: "proposed",
			workKind: "coding",
			titleContains: "ship",
			limit: 10,
		});

		expect(workItemsApi.list).toHaveBeenCalledWith({
			limit: 10,
			disposition: "proposed",
			workKind: "coding",
			titleContains: "ship",
		});
		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toEqual({
			items: [
				{
					id: ITEM_ID,
					title: "Ship the thing",
					disposition: "proposed",
					workKind: "coding",
					workClass: "objective",
					deepLink: `/work/items/${ITEM_ID}`,
				},
			],
			pagination: { limit: 10, hasMore: false },
		});
	});

	it("list_work_items clamps limit into 1..50 and defaults to 25", async () => {
		workItemsApi.list.mockResolvedValue({
			data: [],
			pagination: { limit: 50, hasMore: false },
		});
		const { byName } = tools();
		await byName.get("list_work_items")!.execute({ limit: 999 });
		expect(workItemsApi.list).toHaveBeenLastCalledWith({ limit: 50 });
		await byName.get("list_work_items")!.execute({});
		expect(workItemsApi.list).toHaveBeenLastCalledWith({ limit: 25 });
	});

	it("get_work_item returns a compact detail with a deep link", async () => {
		workItemsApi.getById.mockResolvedValue({
			workItem: {
				...workItemRow,
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
		const { byName } = tools();
		const result = await byName.get("get_work_item")!.execute({ id: ITEM_ID });
		expect(workItemsApi.getById).toHaveBeenCalledWith({ id: ITEM_ID });
		expect(result.structuredContent).toMatchObject({
			id: ITEM_ID,
			title: "Ship the thing",
			doneLooksLike: "It is deployed",
			commentsCount: 1,
			latestComments: [
				{
					authorType: "user",
					body: "Looks good",
					createdAt: "2026-08-26T00:00:00Z",
				},
			],
			deepLink: `/work/items/${ITEM_ID}`,
		});
	});

	it("create_work_item maps input, returns the new id, and invalidates work caches", async () => {
		workItemsApi.create.mockResolvedValue({ ...workItemRow });
		const { byName, invalidateQueries } = tools();
		const result = await byName.get("create_work_item")!.execute({
			title: "Ship the thing",
			workKind: "coding",
			workClass: "objective",
			objectiveId: "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a",
		});

		expect(workItemsApi.create).toHaveBeenCalledWith({
			title: "Ship the thing",
			workKind: "coding",
			workClass: "objective",
			objectiveId: "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a",
		});
		expect(result.structuredContent).toEqual({
			id: ITEM_ID,
			title: "Ship the thing",
			disposition: "proposed",
			deepLink: `/work/items/${ITEM_ID}`,
		});

		const invalidatedKeys = invalidateQueries.mock.calls.map(
			(call) => call[0]?.queryKey,
		);
		expect(invalidatedKeys).toContainEqual(
			workReadinessProjectionQueryOptions().queryKey,
		);
		expect(invalidatedKeys).toContainEqual(
			osQuery.workItems.key({ type: "query" }),
		);
	});

	it("comment_work_item posts the comment and invalidates the item detail", async () => {
		workItemsApi.addComment.mockResolvedValue({ id: "c9" });
		const { byName, invalidateQueries } = tools();
		const result = await byName.get("comment_work_item")!.execute({
			id: ITEM_ID,
			body: "On it",
		});
		expect(workItemsApi.addComment).toHaveBeenCalledWith({
			id: ITEM_ID,
			body: "On it",
		});
		expect(result.structuredContent).toMatchObject({
			commentId: "c9",
			workItemId: ITEM_ID,
		});
		expect(invalidateQueries).toHaveBeenCalledWith({
			queryKey: workItemDetailQueryOptions(ITEM_ID).queryKey,
		});
	});

	it("surfaces an osApi rejection as an isError result, not a throw", async () => {
		workItemsApi.create.mockRejectedValue(
			new Error("purpose gate: objectiveId required"),
		);
		const { byName, invalidateQueries } = tools();
		const result = await byName.get("create_work_item")!.execute({
			title: "Ship the thing",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("purpose gate");
		expect(invalidateQueries).not.toHaveBeenCalled();
	});

	it("list_pending_approvals keeps only pending rows the actor can decide", async () => {
		const proposal = (id: string) => ({
			id,
			action: "start_high_risk",
			requestRationale: "Needs a human sign-off",
			approverType: "user",
			approverId: "U_approver",
			expiresAt: "2026-08-27T00:00:00Z",
		});
		workApprovalsApi.listInbox.mockResolvedValue({
			data: [
				{
					proposal: proposal("p-decidable"),
					effectiveStatus: "pending",
					canDecide: true,
					decision: null,
					workItem: { id: ITEM_ID, title: "Ship the thing", projectId: null },
				},
				{
					proposal: proposal("p-not-mine"),
					effectiveStatus: "pending",
					canDecide: false,
					decision: null,
					workItem: { id: ITEM_ID, title: "Ship the thing", projectId: null },
				},
				{
					proposal: proposal("p-resolved"),
					effectiveStatus: "approved",
					canDecide: false,
					decision: { decision: "approved" },
					workItem: { id: ITEM_ID, title: "Ship the thing", projectId: null },
				},
				{
					proposal: proposal("p-expired"),
					effectiveStatus: "expired",
					canDecide: true,
					decision: null,
					workItem: { id: ITEM_ID, title: "Ship the thing", projectId: null },
				},
			],
			nextCursor: null,
			hasMore: false,
			observedAt: "2026-08-26T00:00:00Z",
		});
		const { byName } = tools();
		const result = await byName.get("list_pending_approvals")!.execute({});
		expect(workApprovalsApi.listInbox).toHaveBeenCalledWith({ limit: 50 });
		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toEqual({
			approvals: [
				{
					proposalId: "p-decidable",
					action: "start_high_risk",
					workItemId: ITEM_ID,
					workItemTitle: "Ship the thing",
					requestRationale: "Needs a human sign-off",
					approverType: "user",
					approverId: "U_approver",
					expiresAt: "2026-08-27T00:00:00Z",
				},
			],
			deepLink: "/work/approvals",
		});
	});

	it("list_pending_approvals forwards the optional workItemId filter", async () => {
		workApprovalsApi.listInbox.mockResolvedValue({
			data: [],
			nextCursor: null,
			hasMore: false,
			observedAt: "2026-08-26T00:00:00Z",
		});
		const { byName } = tools();
		await byName
			.get("list_pending_approvals")!
			.execute({ workItemId: ITEM_ID });
		expect(workApprovalsApi.listInbox).toHaveBeenCalledWith({
			limit: 50,
			workItemId: ITEM_ID,
		});
	});

	it("validates required args locally without calling the API", async () => {
		const { byName } = tools();
		const missingId = await byName.get("get_work_item")!.execute({});
		expect(missingId.isError).toBe(true);
		const missingBody = await byName
			.get("comment_work_item")!
			.execute({ id: ITEM_ID });
		expect(missingBody.isError).toBe(true);
		expect(workItemsApi.getById).not.toHaveBeenCalled();
		expect(workItemsApi.addComment).not.toHaveBeenCalled();
	});
});

describe("WebMCP execution cancellation", () => {
	it("forwards the browser AbortSignal to Work reads", async () => {
		const controller = new AbortController();
		const { byName } = tools();
		await byName
			.get("list_work_items")!
			.execute({}, { signal: controller.signal });
		expect(workItemsApi.list).toHaveBeenCalledWith(
			{ limit: 25 },
			{ signal: controller.signal },
		);
	});
});
