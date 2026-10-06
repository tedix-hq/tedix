import { describe, expect, it } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import {
	canCancelOwnApproval,
	normalizeProvisionalOutcome,
	resolveApprovalPrincipal,
	signalApprovalWorkflow,
} from "./tedi-approvals";
import { isApprovedProvisionalPromotion } from "../../services/provisional-outcome-promotion";

describe("tedi approval cancellation ownership", () => {
	it("allows only the requesting tedi identity", () => {
		expect(canCancelOwnApproval("tedi-1", "tedi-1")).toBe(true);
		expect(canCancelOwnApproval("tedi-2", "tedi-1")).toBe(false);
		expect(canCancelOwnApproval(undefined, "tedi-1")).toBe(false);
	});
});

describe("provisional outcome API projection", () => {
	it("marks the record provisional without manufacturing approval authority", () => {
		const result = normalizeProvisionalOutcome({
			id: "019d0000-0000-7000-8000-000000000001",
			tediId: "019d0000-0000-7000-8000-000000000002",
			orgId: "019d0000-0000-7000-8000-000000000003",
			conversationId: "conversation-1",
			runId: "run-1",
			kind: "draft",
			title: "Draft answer",
			payload: { body: "analysis may continue" },
			createdAt: "2026-09-03T00:00:00.000Z",
			state: "provisional",
			promotionApprovalRequestId: null,
			promotedAt: null,
			promotedBy: null,
			rolledBackAt: null,
			rolledBackBy: null,
			rollbackReason: null,
		});

		expect(result.state).toBe("provisional");
		expect(result).not.toHaveProperty("status");
		expect(result).not.toHaveProperty("workflowId");
		expect(result).not.toHaveProperty("approvalRequestId");
	});
});

describe("provisional promotion authority", () => {
	const outcome = { id: "outcome-1", orgId: "org-1", tediId: "tedi-1" };
	const approval = {
		actionType: "provisional_outcome_promotion",
		orgId: "org-1",
		tediId: "tedi-1",
		status: "approved" as const,
		payload: {
			kind: "provisional_outcome_promotion_v2",
			provisionalOutcomeId: "outcome-1",
			provisionalOutcomeHash: "sha256:proposal",
		},
	};
	it("requires the approved typed request to bind the exact tenant, tedi, and outcome", () => {
		expect(
			isApprovedProvisionalPromotion(approval, outcome, "sha256:proposal"),
		).toBe(true);
		expect(
			isApprovedProvisionalPromotion(
				{ ...approval, status: "pending" },
				outcome,
				"sha256:proposal",
			),
		).toBe(false);
		expect(
			isApprovedProvisionalPromotion(
				{ ...approval, orgId: "org-2" },
				outcome,
				"sha256:proposal",
			),
		).toBe(false);
		expect(
			isApprovedProvisionalPromotion(
				{
					...approval,
					payload: { ...approval.payload, provisionalOutcomeId: "other" },
				},
				outcome,
				"sha256:proposal",
			),
		).toBe(false);
		expect(
			isApprovedProvisionalPromotion(approval, outcome, "sha256:changed"),
		).toBe(false);
	});

	it("rejects legacy promotion approvals that have no immutable outcome hash", () => {
		expect(
			isApprovedProvisionalPromotion(
				{
					...approval,
					payload: {
						kind: "provisional_outcome_promotion_v1",
						provisionalOutcomeId: outcome.id,
					},
				},
				outcome,
				"sha256:proposal",
			),
		).toBe(false);
	});
});

describe("approval workflow signaling", () => {
	it("sends the terminal D1 status to the exact stored Workflow instance", async () => {
		const sendEvent = async (event: unknown) => event;
		let resolvedId: string | undefined;
		let sent: unknown;
		const context = {
			env: {
				APPROVAL_WORKFLOW: {
					get: async (id: string) => {
						resolvedId = id;
						return {
							sendEvent: async (event: unknown) => {
								sent = await sendEvent(event);
							},
						};
					},
				},
			},
		} as unknown as BaseContext;

		await signalApprovalWorkflow(context, {
			id: "approval-1",
			tediId: "tedi-1",
			orgId: "org-1",
			actionType: "os_gadget_execution",
			description: "Dispatch Gadget",
			payload: { executionId: "execution-1" },
			status: "approved",
			createdAt: "2026-08-17T00:00:00.000Z",
			expiresAt: "2026-08-20T00:00:00.000Z",
			resolvedAt: "2026-08-17T00:01:00.000Z",
			resolvedBy: "approver-1",
			resolution: null,
			workflowId: "approval-workflow-1",
		});

		expect(resolvedId).toBe("approval-workflow-1");
		expect(sent).toEqual({
			type: "approval-resolution",
			payload: { approvalRequestId: "approval-1", status: "approved" },
		});
	});
});

describe("product-motion rig approval principal", () => {
	const request = {
		payload: { kind: "product_motion_rig_admission_v1" },
	};

	it("records a typed human principal", () => {
		expect(
			resolveApprovalPrincipal(
				{ authType: "user", user: { sub: "human-1" } },
				request,
			),
		).toBe("user:human-1");
	});

	it("rejects service and tedi resolvers", () => {
		expect(() =>
			resolveApprovalPrincipal({ authType: "service-binding" }, request),
		).toThrow("authenticated human approver");
		expect(() =>
			resolveApprovalPrincipal(
				{
					authType: "user",
					tediId: "tedi-1",
					user: { sub: "ambiguous" },
				},
				request,
			),
		).toThrow("authenticated human approver");
	});
});

describe("payment budget override approval principal", () => {
	const request = { payload: { kind: "payment_budget_override" } };
	it("requires a human identity for both single and manifest resolution", () => {
		expect(
			resolveApprovalPrincipal(
				{ authType: "user", user: { sub: "owner-1" } },
				request,
			),
		).toBe("user:owner-1");
		expect(() =>
			resolveApprovalPrincipal({ authType: "tedi", tediId: "tedi-1" }, request),
		).toThrow("authenticated human approver");
	});
});

describe("embedded host approval principal", () => {
	it("preserves trusted host-user provenance for ordinary approvals", () => {
		expect(
			resolveApprovalPrincipal(
				{
					authType: "service-binding",
					gatewayEndUserId: "1743",
					tediId: "tedi-1",
				},
				{ payload: { kind: "tool_write" } },
			),
		).toBe("user:1743");
	});
});
