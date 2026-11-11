import { createRouterClient } from "@orpc/server";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";

const mocks = vi.hoisted(() => ({
	get: vi.fn(),
	resolve: vi.fn(),
	app: vi.fn(),
	refresh: vi.fn(),
}));
vi.mock("@tedix/db/queries/approvals", async (load) => ({
	...(await load<typeof import("@tedix/db/queries/approvals")>()),
	getApprovalRequestById: mocks.get,
	resolveToolCatalogApprovalRequest: mocks.resolve,
}));
vi.mock("@tedix/db/queries/app-records", async (load) => ({
	...(await load<typeof import("@tedix/db/queries/app-records")>()),
	getAppByIdForOrganization: mocks.app,
}));
vi.mock("../../services/tool-review-approvals", () => ({
	ensurePendingToolReviewApprovals: mocks.refresh,
}));
import { tediApprovalsContractRouter } from "./tedi-approvals";

const request = {
	id: `tool-review-${"a".repeat(64)}`,
	tediId: "anchor",
	orgId: "org",
	actionType: "mcp.tool_catalog_change",
	description: "Review tools",
	status: "pending",
	createdAt: "2026-11-01T00:00:00.000Z",
	expiresAt: "2099-01-01T00:00:00.000Z",
	resolvedAt: null,
	resolvedBy: null,
	resolution: null,
	workflowId: null,
	payload: {
		kind: "mcp_tool_catalog_change",
		appId: "app",
		reviewBatchId: "old",
		expectedCount: 2,
		changes: [],
	},
};
function client() {
	return createRouterClient(tediApprovalsContractRouter, {
		context: {
			authType: "apikey",
			apiKey: { id: "key", organizationId: "org", scopes: ["*"] },
			organizationId: "org",
			db: {},
			env: { ENVIRONMENT: "test" },
			headers: new Headers(),
			url: new URL("https://api.example.test/rpc/tediApprovals/resolve"),
			rateLimiter: { limit: vi.fn(async () => ({ success: true })) },
		} as unknown as BaseContext,
	});
}
beforeEach(() => {
	vi.resetAllMocks();
	mocks.get.mockResolvedValue(request);
});
it("refreshes a mismatched card and explains that no approval was recorded", async () => {
	mocks.resolve.mockResolvedValue(undefined);
	mocks.app.mockResolvedValue({ id: "app", name: "App" });
	await expect(
		client().resolve({ id: request.id, status: "approved" }),
	).rejects.toMatchObject({
		code: "CONFLICT",
		message: expect.stringContaining("Refresh to review the latest card"),
	});
	expect(mocks.refresh).toHaveBeenCalledWith(
		{},
		{ organizationId: "org", appId: "app", appName: "App" },
	);
});
it("gives the refresh message for a card superseded while it was open", async () => {
	mocks.get.mockResolvedValue({
		...request,
		status: "cancelled",
		resolution: "Superseded",
	});
	await expect(
		client().resolve({ id: request.id, status: "approved" }),
	).rejects.toMatchObject({
		code: "CONFLICT",
		message: expect.stringContaining("no decision was recorded"),
	});
	expect(mocks.resolve).not.toHaveBeenCalled();
});
it("does not refresh another organization's card", async () => {
	mocks.get.mockResolvedValue({ ...request, orgId: "other" });
	await expect(
		client().resolve({ id: request.id, status: "approved" }),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	expect(mocks.refresh).not.toHaveBeenCalled();
});
