import { beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
	anchor: vi.fn(),
	create: vi.fn(),
	existing: vi.fn(),
	pending: vi.fn(),
}));

vi.mock("@tedix/db/queries/approvals", () => ({
	createApprovalRequest: mocks.create,
	getApprovalAnchor: mocks.anchor,
	getApprovalRequestById: mocks.existing,
}));
vi.mock("@tedix/db/queries/tools", () => ({
	listPendingToolReviewsForApp: mocks.pending,
}));

import { ensurePendingToolReviewApprovals } from "./tool-review-approvals";

beforeEach(() => {
	vi.resetAllMocks();
	mocks.anchor.mockResolvedValue({ id: "home-tedi" });
	mocks.existing.mockResolvedValue(undefined);
	mocks.create.mockImplementation(async (_db, input) => input);
});

it("creates one OS approval request carrying every diff in a scan batch", async () => {
	mocks.pending.mockResolvedValue([
		{
			rowId: "row-a",
			toolId: "tool_a",
			schemaSourceHash: "hash-a",
			reviewBatchId: "batch",
			diff: { source: "upstream_mcp", before: null, after: {} },
		},
		{
			rowId: "row-b",
			toolId: "tool_b",
			schemaSourceHash: "hash-b",
			reviewBatchId: "batch",
			diff: { source: "upstream_mcp", before: null, after: {} },
		},
	]);

	await ensurePendingToolReviewApprovals({} as never, {
		organizationId: "org",
		appId: "app",
		appName: "Upstream",
	});

	expect(mocks.create).toHaveBeenCalledTimes(1);
	expect(mocks.create.mock.calls[0]?.[1]).toMatchObject({
		tediId: "home-tedi",
		orgId: "org",
		actionType: "mcp.tool_catalog_change",
		payload: {
			kind: "mcp_tool_catalog_change",
			appId: "app",
			reviewBatchId: "batch",
			expectedCount: 2,
			changes: [
				{ rowId: "row-a", toolId: "tool_a", schemaSourceHash: "hash-a" },
				{ rowId: "row-b", toolId: "tool_b", schemaSourceHash: "hash-b" },
			],
		},
	});
});
