import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";

/**
 * Org-scope regression suite for the approval queue list.
 *
 * Tedix OS calls
 * `tediApprovals.list` with NO `tediId` filter to get the org-wide pending
 * queue. The `tedi_approval_requests` table is cross-tenant, so the only
 * fence is the handler passing the caller's org into the query — and
 * rejecting callers that have neither an org context nor a `tediId`. Pin
 * both.
 */

const mocks = vi.hoisted(() => ({
	listApprovalRequests: vi.fn(),
}));

vi.mock("@tedix/db/queries/approvals", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/db/queries/approvals")>()),
	listApprovalRequests: mocks.listApprovalRequests,
}));

import { tediApprovalsContractRouter } from "./tedi-approvals";

function approvalRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "5b0e8a3c-1d2e-4f5a-8b9c-0d1e2f3a4b5c",
		tediId: "9a8b7c6d-5e4f-4a3b-9c8d-7e6f5a4b3c2d",
		orgId: "org-1",
		actionType: "deploy",
		description: "Approve production deploy",
		payload: { kind: "test" },
		status: "pending",
		createdAt: "2026-08-06T10:00:00.000Z",
		expiresAt: "2026-08-07T10:00:00.000Z",
		resolvedAt: null,
		resolvedBy: null,
		resolution: null,
		workflowId: null,
		...overrides,
	};
}

function createContext(organizationId: string | undefined): BaseContext {
	return {
		authType: "apikey",
		apiKey: {
			id: "api-key-1",
			name: "test",
			organizationId,
			scopes: ["*"],
		},
		db: {} as BaseContext["db"],
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers(),
		...(organizationId ? { organizationId } : {}),
		rateLimiter: {
			limit: vi.fn(async () => ({ success: true })),
		} as unknown as RateLimit,
		url: new URL("https://api.tedix.test/rpc/tedi-approvals"),
		user: undefined,
	} as BaseContext;
}

function createClient(context: BaseContext) {
	return createRouterClient(tediApprovalsContractRouter, { context });
}

beforeEach(() => {
	mocks.listApprovalRequests.mockReset();
	mocks.listApprovalRequests.mockResolvedValue({
		data: [approvalRow()],
		total: 1,
	});
});

describe("tediApprovals.list org scoping", () => {
	it("retains personal context filtering for an organization admin's Deck", async () => {
		const context = {
			...createContext("org-1"),
			authType: "user",
			user: { sub: "fictional-admin" },
			userRole: "admin",
		} as BaseContext;
		await createClient(context).list({
			status: "pending",
			decidableOnly: true,
		});
		expect(mocks.listApprovalRequests).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				orgId: "org-1",
				viewerUserId: "fictional-admin",
			}),
		);
	});
	it("does not put admin-only runtime approvals in a non-admin member's decision inbox", async () => {
		const context = {
			...createContext("org-1"),
			authType: "user",
			user: { sub: "fictional-luz" },
			userRole: "member",
		} as BaseContext;
		const result = await createClient(context).list({
			status: "pending",
			decidableOnly: true,
		});
		expect(result.data).toEqual([]);
		expect(result.pagination.total).toBe(0);
		expect(mocks.listApprovalRequests).not.toHaveBeenCalled();
	});
	it("scopes an unfiltered (org-wide) list by the caller's org_id", async () => {
		const client = createClient(createContext("org-1"));

		const result = await client.list({ status: "pending", limit: 6 });

		expect(mocks.listApprovalRequests).toHaveBeenCalledTimes(1);
		const options = mocks.listApprovalRequests.mock.calls[0]?.[1];
		expect(options).toMatchObject({
			orgId: "org-1",
			status: "pending",
			limit: 6,
			offset: 0,
		});
		// No tedi narrowing — org-wide means every tedi's approvals in THIS org.
		expect(options?.tediId).toBeUndefined();
		expect(result.data.map((row) => row.id)).toEqual([
			"5b0e8a3c-1d2e-4f5a-8b9c-0d1e2f3a4b5c",
		]);
	});

	it("rejects a caller with neither an org context nor a tediId filter", async () => {
		const client = createClient(createContext(undefined));

		await expect(client.list({ status: "pending" })).rejects.toMatchObject({
			message: "tediId is required for service binding calls",
		});
		expect(mocks.listApprovalRequests).not.toHaveBeenCalled();
	});
});
