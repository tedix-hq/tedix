import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
const mocks = vi.hoisted(() => ({
	find: vi.fn(),
	set: vi.fn(),
}));
vi.mock("@tedix/db/queries/mcp-governance", async (load) => ({
	...(await load<object>()),
	findActionTypeOptIn: mocks.find,
	setActionTypeOptIn: mocks.set,
}));
import { mcpGovernanceContractRouter } from "./mcp-governance";

function client() {
	return createRouterClient(mcpGovernanceContractRouter, {
		context: {
			authType: "service-binding",
			organizationId: "org-1",
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
	mocks.find.mockResolvedValue({
		grantId: "grant-1",
		actionType: "comment_on_issue",
		reason: "set by user:owner-1",
		createdAt: "2026-10-27 12:00:00",
	});
});

describe("action type opt-in", () => {
	it("approves an opted-in action type for the gateway organization", async () => {
		expect(
			await client().resolveActionTypeOptIn({
				organizationId: "org-1",
				actionType: "comment_on_issue",
			}),
		).toEqual({ approved: true, grantId: "grant-1" });
	});

	it("refuses a platform-critical type even when a row exists", async () => {
		expect(
			await client().resolveActionTypeOptIn({
				organizationId: "org-1",
				actionType: "send_email",
			}),
		).toEqual({ approved: false, grantId: null });
		expect(mocks.find).not.toHaveBeenCalled();
	});

	it("refuses another organization's lookup", async () => {
		await expect(
			client().resolveActionTypeOptIn({
				organizationId: "org-2",
				actionType: "comment_on_issue",
			}),
		).rejects.toThrow(/does not match the gateway context/);
	});

	it("lets no service caller change the opt-in", async () => {
		await expect(
			client().setActionTypeOptIn({
				actionType: "comment_on_issue",
				enabled: true,
			}),
		).rejects.toThrow(/owner or admin|scope 'apps:write' required/);
		expect(mocks.set).not.toHaveBeenCalled();
	});
});
