import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";

const mocks = vi.hoisted(() => ({ create: vi.fn(), anchor: vi.fn() }));
vi.mock("@tedix/db/queries/approvals", async (load) => ({
	...(await load<object>()),
	createApprovalRequestWithAudit: mocks.create,
	getApprovalAnchor: mocks.anchor,
}));
import { mcpGovernanceContractRouter } from "./mcp-governance";

function client() {
	return createRouterClient(mcpGovernanceContractRouter, {
		context: {
			authType: "service-binding",
			organizationId: "example-org",
			db: {},
			env: { ENVIRONMENT: "production" },
			headers: new Headers({ "X-Service-Binding": "true" }),
			url: new URL("https://api.test/rpc"),
			rateLimiter: { limit: async () => ({ success: true }) },
		} as BaseContext,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.anchor.mockResolvedValue({ id: "example-anchor" });
	mocks.create.mockResolvedValue({});
});

describe("gateway automatic approval reason", () => {
	it.each(["delegation_autonomy", "native_policy", "work_items"])(
		"stores the winning %s rule and reason together",
		async (operationId) => {
			const input = {
				organizationId: "example-org",
				appSlug: "notes",
				toolId: "update_note",
				operationId,
				reason: `Allowed by ${operationId}`,
			};
			const result = await client().recordPolicyToolApproval(input);
			expect(result.approvalRequestId).toEqual(expect.any(String));
			expect(mocks.create).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					automaticApproval: { tediId: "policy", reason: input.reason },
					payload: expect.objectContaining({
						approvalRule: operationId,
						approvalReason: input.reason,
					}),
				}),
				expect.objectContaining({
					metadata: expect.objectContaining({
						approvalRule: operationId,
						approvalReason: input.reason,
					}),
				}),
			);
		},
	);
	it("rejects a different organization without recording a decision", async () => {
		await expect(
			client().recordPolicyToolApproval({
				organizationId: "other-org",
				appSlug: "notes",
				toolId: "update_note",
				operationId: "work_items",
				reason: "example",
			}),
		).rejects.toThrow("organization does not match");
		expect(mocks.create).not.toHaveBeenCalled();
	});
});
