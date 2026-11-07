import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
const mocks = vi.hoisted(() => ({
	list: vi.fn(),
	set: vi.fn(),
}));
vi.mock("@tedix/db/queries/mcp-governance", async (load) => ({
	...(await load<object>()),
	listOrganizationAutoApproval: mocks.list,
	setOrganizationAutoApprovalEntry: mocks.set,
}));
vi.mock("@tedix/db/queries/kernel-runtime-support", async (load) => ({
	...(await load<object>()),
	getActivePolicyPackDefinition: vi.fn(async () => null),
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

const EMPTY = { disabledGroups: [], addedTools: [], removedTools: [] };

beforeEach(() => {
	vi.clearAllMocks();
	mocks.list.mockResolvedValue(EMPTY);
});

describe("organization auto-approval", () => {
	it("hands the gateway the organization's changes", async () => {
		const changes = {
			disabledGroups: ["runs"],
			addedTools: ["start_widget_preview"],
			removedTools: [],
		};
		mocks.list.mockResolvedValue(changes);
		expect(
			await client().resolveAgentTransportPolicy({ organizationId: "org-1" }),
		).toMatchObject({ autoApproval: changes });
	});

	it("leaves the default alone when nothing changed or the read fails", async () => {
		expect(
			await client().resolveAgentTransportPolicy({ organizationId: "org-1" }),
		).not.toHaveProperty("autoApproval");
		mocks.list.mockRejectedValue(new Error("D1 overloaded"));
		expect(
			await client().resolveAgentTransportPolicy({ organizationId: "org-1" }),
		).not.toHaveProperty("autoApproval");
	});

	it("lets no service caller change it", async () => {
		await expect(
			client().setOrganizationAutoApproval({
				kind: "tool",
				toolName: "start_widget_preview",
				mode: "auto",
			}),
		).rejects.toThrow(/owner or admin|scope 'apps:write' required/);
		expect(mocks.set).not.toHaveBeenCalled();
	});
});
