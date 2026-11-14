import { describe, expect, it, vi } from "vite-plus/test";
import { admitGatewayCall } from "./gateway-adapters";
import { toolApprovalMetadata } from "./tool-risk-policy";
import type { AppTool, ServerContext } from "./server-context";

const tool = {
	toolId: "update_settings",
	title: "Update settings",
	inputSchema: { type: "object", properties: {} },
	config: { transport: "rpc", endpoint: "organizations/update" },
	meta: { "com.tedix/policy": { requiredRole: "admin_or_owner" } },
} satisfies Pick<
	AppTool,
	"toolId" | "title" | "inputSchema" | "config" | "meta"
>;

it("isolates verified approvers across concurrent exact-call admissions", async () => {
	const agent = {
		server: { server: { elicitInput: vi.fn() } },
		appSlug: "example",
		app: { organizationId: "org-1" },
		callerIdentity: {
			authType: "service",
			kernel: true,
			userId: "requester",
			organizationId: "org-1",
		},
		apiClient: {
			mcpGovernance: {
				requestOwnerToolApproval: vi.fn(async ({ args }) => ({
					approved: args.allow,
					approvedUserId: args.allow ? args.approver : undefined,
					status: args.allow ? "consumed" : "pending",
					approvalRequestId: "approval",
					url: "https://example.test",
				})),
			},
		},
	} as unknown as ServerContext;
	const admissions = await Promise.all(
		[true, false, true].map((allow, i) => {
			const args = { allow, approver: `owner-${i}` };
			return admitGatewayCall({
				agent,
				tool,
				args,
				annotations: { destructiveHint: true },
				approval: {
					args,
					extra: { _meta: { "com.tedix/approvalRequestId": "approval" } },
				},
			});
		}),
	);
	expect(admissions.map((a) => a.verifiedOwnerToolUserId)).toEqual([
		"owner-0",
		undefined,
		"owner-2",
	]);
	expect(admissions[1]?.failure?.isError).toBe(true);
	expect(agent.callerIdentity?.approvedToolUserId).toBeUndefined();
});

describe("role discovery", () => {
	it("publishes a role declaration even without a risk tier", () => {
		expect(toolApprovalMetadata(tool)).toMatchObject({
			"com.tedix/policy": { requiredRole: "admin_or_owner" },
		});
	});
});

it.each([undefined, "host-agent-session"])(
	"distinguishes a human call from an owner-host agent (%s)",
	async (ownerHostSessionId) => {
		const request = vi.fn(async () => ({
			approved: true,
			status: "self_authorized",
			url: "https://example.test",
		}));
		const agent = {
			server: { server: { elicitInput: vi.fn() } },
			appSlug: "example",
			app: { organizationId: "org-1" },
			callerIdentity: {
				authType: "oauth",
				userId: "owner",
				organizationId: "org-1",
				ownerHostSessionId,
			},
			apiClient: { mcpGovernance: { requestOwnerToolApproval: request } },
		} as unknown as ServerContext;
		await admitGatewayCall({
			agent,
			tool,
			args: {},
			annotations: { destructiveHint: true },
			approval: { args: {} },
		});
		expect(request).toHaveBeenCalledWith(
			expect.objectContaining({ directUserCall: !ownerHostSessionId }),
		);
	},
);
