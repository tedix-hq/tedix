import type { ChangeRecordInput as LedgerInput } from "@tedix/agent-governance/types";
import { describe, expect, it, vi } from "vite-plus/test";
import { createInMemoryAdapters } from "@tedix/agent-governance/in-memory";
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
			audit: {
				appendChangeRecord: (input: LedgerInput) =>
					createInMemoryAdapters().accountability.append(input),
			},
			mcpGovernance: {
				requestOwnerToolApproval: vi.fn(async ({ args }) => ({
					approved: args.allow,
					approvedUserId: args.allow ? args.approver : undefined,
					status: args.allow ? "consumed" : "pending",
					approvalRequestId: "approval",
					url: "https://example.test",
					...(args.allow
						? {
								evidence: {
									approverId: args.approver,
									approvedAt: "2026-11-19T09:00:00.000Z",
									presentedHash: "e".repeat(64),
								},
							}
						: {}),
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
	const records = await Promise.all(
		admissions.map((admission) => admission.settle({ status: "applied" })),
	);
	expect(records[1]).toBeNull();
	for (const i of [0, 2]) {
		const record = records[i]!;
		// The approval bound exactly the recorded arguments: same hash function.
		expect(record.approval).toEqual({
			kind: "owner_request",
			approverId: `owner-${i}`,
			approvedAt: "2026-11-19T09:00:00.000Z",
			presentedHash: "e".repeat(64),
			approvalRequestId: "approval",
			boundArgsHash: record.argsHash,
			singleUse: true,
			policy: { configHash: expect.stringMatching(/^[0-9a-f]{64}$/) },
		});
	}
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
			apiClient: {
				audit: {
					appendChangeRecord: (input: LedgerInput) =>
						createInMemoryAdapters().accountability.append(input),
				},
				mcpGovernance: { requestOwnerToolApproval: request },
			},
		} as unknown as ServerContext;
		const admission = await admitGatewayCall({
			agent,
			tool,
			args: {},
			annotations: { destructiveHint: true },
			approval: { args: {} },
		});
		expect(request).toHaveBeenCalledWith(
			expect.objectContaining({ directUserCall: !ownerHostSessionId }),
		);
		// The caller decided: no request, nothing shown, nothing consumed.
		const record = await admission.settle({ status: "applied" });
		expect(record?.approval).toEqual({
			kind: "self_authorized",
			approverId: "owner",
			approvedAt: expect.any(String),
			singleUse: false,
			policy: { configHash: expect.stringMatching(/^[0-9a-f]{64}$/) },
		});
	},
);

it("parks a dispatcher's gated native write and returns its approval id without authorizing execution", async () => {
	const request = vi.fn(async () => ({
		approved: false,
		status: "pending",
		approvalRequestId: "approval-1",
		url: "https://example.test/work/approvals#approval-1",
	}));
	const agent = {
		server: { server: { elicitInput: vi.fn() } },
		appSlug: "connect",
		app: { organizationId: "org-1" },
		callerIdentity: {
			authType: "external_agent",
			organizationId: "org-1",
			externalAgentPrincipalId: "machine",
			externalAgentSessionId: "session",
			externalAgentClientRecordId: "client",
			requestWorkItemId: "work",
		},
		apiClient: { mcpGovernance: { requestOwnerToolApproval: request } },
	} as unknown as ServerContext;
	const args = { items: [{ label: "Home", url: "/" }] };
	const admission = await admitGatewayCall({
		agent,
		tool: {
			...tool,
			toolId: "cms_landing__menu_set_items",
			config: { transport: "rpc", endpoint: "cmsLanding/menuSetItems" },
		},
		args,
		annotations: { destructiveHint: true },
		approval: { args, autoConfirmAgent: true, allowSyncMrtr: false },
	});
	expect(request).toHaveBeenCalledWith(
		expect.objectContaining({
			requestingAgent: {
				principalId: "machine",
				sessionId: "session",
				clientRecordId: "client",
			},
			workItemId: "work",
			args,
			directUserCall: false,
		}),
	);
	expect(admission.failure).toMatchObject({
		isError: true,
		_meta: {
			"com.tedix/approval": {
				approvalRequestId: "approval-1",
				status: "pending",
			},
		},
	});
	expect(admission.verifiedOwnerToolUserId).toBeUndefined();
	expect(
		await admission.settle({
			status: "not_applied",
			error: "Human approval required",
		}),
	).toBeNull();
});
