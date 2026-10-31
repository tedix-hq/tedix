import { describe, expect, it } from "vite-plus/test";
import { apiKeyContext, userContext } from "../rpc/test-context";
import {
	approvalPayloadForViewer,
	approvalReceiptForViewer,
	canReadApprovalResult,
} from "./approval-result-privacy";
import { normalizeApprovalRequest as runtimeApproval } from "../rpc/routers/cognitive-runtime/events-policy";
import type { TediApprovalRequest } from "@tedix/db/schema/approvals";
import type { BaseContext } from "../rpc/orpc";

const SECRET = "private-result-marker";
const payload = {
	kind: "mcp_tool_call",
	initiatedByUserId: "requester",
	appSlug: "example",
	toolId: "example_issue_credential",
	target: { transport: "rpc" },
	args: {},
	fingerprint: "example-fingerprint",
	executionResult: { token: SECRET },
	execution: {
		status: "executed",
		startedAt: "2026-01-01T00:00:00Z",
		summary: SECRET,
		error: SECRET,
		result: { token: SECRET },
	},
};
function approval(
	extra: Partial<TediApprovalRequest> = {},
): TediApprovalRequest {
	return {
		id: "00000000-0000-4000-8000-000000000001",
		tediId: "routing-tedi",
		orgId: "org-1",
		actionType: "mcp.tool_call",
		description: "Example credential request",
		payload,
		status: "approved",
		createdAt: "2026-01-01T00:00:00Z",
		expiresAt: "2026-01-02T00:00:00Z",
		resolvedAt: null,
		resolvedBy: null,
		resolution: null,
		workflowId: null,
		...extra,
	};
}
describe("approval execution result privacy", () => {
	it("returns original results only to the authenticated original owner-call requester", async () => {
		const row = approval();
		const context = userContext({ sub: "requester" });
		expect(await approvalPayloadForViewer(context, row)).toEqual(payload);
		expect(await canReadApprovalResult(context, row)).toBe(true);
	});
	it.each(["other-member", "other-admin"])(
		"redacts results and provider echoes for same-org %s",
		async (sub) => {
			const visible = await approvalPayloadForViewer(
				userContext({ sub }),
				approval(),
			);
			expect(JSON.stringify(visible)).not.toContain(SECRET);
			expect(visible.executionResult).toEqual({ redacted: true });
			expect(visible.execution).toMatchObject({
				status: "executed",
				startedAt: payload.execution.startedAt,
				redacted: true,
			});
			expect(visible.args).toEqual({});
			expect(payload.executionResult.token).toBe(SECRET);
		},
	);
	it("fails closed for missing identity, service acting-user and admin-scoped machines", async () => {
		const machine = apiKeyContext({ scopes: ["mcp:memory.admin"] });
		for (const context of [
			machine,
			{ ...machine, authType: "service-binding", descopeUserId: "requester" },
			{ ...userContext({ sub: "requester" }), user: undefined },
			{ ...userContext({ sub: "requester" }), organizationId: "org-2" },
		] as BaseContext[]) {
			expect(
				JSON.stringify(await approvalPayloadForViewer(context, approval())),
			).not.toContain(SECRET);
		}
	});
	it("never treats the routing tedi or its owner as the requester of an owner/Home call", async () => {
		const tedi = {
			...apiKeyContext(),
			authType: "tedi",
			tediId: "routing-tedi",
		} as BaseContext;
		expect(await canReadApprovalResult(tedi, approval())).toBe(false);
		expect(
			await canReadApprovalResult(
				userContext({ sub: "routing-owner" }),
				approval(),
			),
		).toBe(false);
		expect(
			await canReadApprovalResult(
				tedi,
				approval({ payload: { kind: "home_tool_write" } }),
			),
		).toBe(false);
	});
	it("does not give a current or transferred human owner historical runtime results", async () => {
		const row = approval({
			actionType: "runtime.permission",
			payload: {
				executionResult: { token: SECRET },
				initiatedByUserId: "runtime-owner",
			},
		});
		expect(
			await canReadApprovalResult(userContext({ sub: "runtime-owner" }), row),
		).toBe(false);
		expect(
			await canReadApprovalResult(userContext({ sub: "other-admin" }), row),
		).toBe(false);
		expect(
			await canReadApprovalResult(
				{
					...apiKeyContext(),
					authType: "tedi",
					tediId: "routing-tedi",
				} as BaseContext,
				row,
			),
		).toBe(true);
	});
	it("redacts both runtime payload and review projection", async () => {
		const projected = await runtimeApproval(
			approval(),
			userContext({ sub: "other-admin" }),
		);
		expect(JSON.stringify(projected)).not.toContain(SECRET);
		expect(projected.status).toBe("approved");
		expect(
			(await runtimeApproval(approval(), userContext({ sub: "requester" })))
				.payload,
		).toEqual(payload);
	});
	it("redacts receipt results/errors without changing audit identity or stored data", () => {
		const receipt = {
			recordHash: "sha256:example",
			outcome: "succeeded",
			observedResult: { result: { token: SECRET } },
			observedError: { message: SECRET },
		};
		const visible = approvalReceiptForViewer(receipt, false);
		expect(JSON.stringify(visible)).not.toContain(SECRET);
		expect(visible.recordHash).toBe(receipt.recordHash);
		expect(approvalReceiptForViewer(receipt, true)).toBe(receipt);
	});
});

it("uses canonical Home requester identity and never substitutes the approver or routing tedi", async () => {
	const home = {
		kind: "home_tool_write",
		appSlug: "example",
		toolName: "example_issue_credential",
		organizationId: "org-1",
		homeRunId: "example-run",
		conversationId: "home:example",
		args: {},
		initiatedByUserId: "requester",
		executionResult: { token: SECRET },
	};
	const row = approval({ actionType: "home.tool_write", payload: home });
	expect(
		await canReadApprovalResult(userContext({ sub: "requester" }), row),
	).toBe(true);
	expect(
		await canReadApprovalResult(userContext({ sub: "approver" }), row),
	).toBe(false);
	const agentRow = approval({
		actionType: "home.tool_write",
		payload: {
			...home,
			initiatedByUserId: null,
			initiatedByAgentPrincipalId: "agent-requester",
		},
	});
	expect(
		await canReadApprovalResult(
			{ ...apiKeyContext(), externalAgentPrincipalId: "agent-requester" },
			agentRow,
		),
	).toBe(true);
	expect(
		await canReadApprovalResult(
			{ ...apiKeyContext(), externalAgentPrincipalId: "other-agent" },
			agentRow,
		),
	).toBe(false);
	expect(await canReadApprovalResult(apiKeyContext(), agentRow)).toBe(false);
	expect(
		await canReadApprovalResult(
			userContext({ sub: "requester" }),
			approval({ actionType: "runtime.permission" }),
		),
	).toBe(false);
});
