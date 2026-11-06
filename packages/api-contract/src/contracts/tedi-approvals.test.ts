import { describe, expect, it } from "vite-plus/test";
import {
	ProvisionalOutcomeSchema,
	tediApprovalsContract,
} from "./tedi-approvals";

describe("provisional outcome contract", () => {
	it("is explicitly non-canonical and carries no executable approval state", () => {
		const parsed = ProvisionalOutcomeSchema.parse({
			id: "019d0000-0000-7000-8000-000000000001",
			tediId: "019d0000-0000-7000-8000-000000000002",
			orgId: "019d0000-0000-7000-8000-000000000003",
			conversationId: null,
			runId: "run-1",
			kind: "draft",
			state: "provisional",
			title: "Draft response",
			payload: { body: "not published" },
			createdAt: "2026-09-03T00:00:00.000Z",
			promotionApprovalRequestId: null,
			promotedAt: null,
			promotedBy: null,
			rolledBackAt: null,
			rolledBackBy: null,
			rollbackReason: null,
		});

		expect(parsed.state).toBe("provisional");
		expect(parsed).not.toHaveProperty("status");
		expect(parsed).not.toHaveProperty("workflowId");
		expect(parsed).not.toHaveProperty("approvalRequestId");
	});

	it("rejects attempts to smuggle approval or executor state", () => {
		const result = ProvisionalOutcomeSchema.safeParse({
			id: "019d0000-0000-7000-8000-000000000001",
			tediId: "019d0000-0000-7000-8000-000000000002",
			orgId: "019d0000-0000-7000-8000-000000000003",
			conversationId: null,
			runId: null,
			kind: "configuration_proposal",
			state: "provisional",
			title: "Draft config",
			payload: {},
			createdAt: "2026-09-03T00:00:00.000Z",
			promotionApprovalRequestId: null,
			promotedAt: null,
			promotedBy: null,
			rolledBackAt: null,
			rolledBackBy: null,
			rollbackReason: null,
			status: "approved",
			workflowId: "executor-1",
		});
		expect(result.success).toBe(false);
	});

	it("exposes explicit promotion and rollback without a generic resolve procedure", () => {
		expect(tediApprovalsContract.createProvisionalOutcome).toBeDefined();
		expect(tediApprovalsContract.listProvisionalOutcomes).toBeDefined();
		expect(
			tediApprovalsContract.requestProvisionalOutcomePromotion,
		).toBeDefined();
		expect(tediApprovalsContract.promoteProvisionalOutcome).toBeDefined();
		expect(tediApprovalsContract.rollbackProvisionalOutcome).toBeDefined();
		expect("resolveProvisionalOutcome" in tediApprovalsContract).toBe(false);
	});
});

describe("ordered approval review contract", () => {
	it("exposes read-only manifest construction and explicit per-action resolution", () => {
		expect(tediApprovalsContract.getReviewManifest).toBeDefined();
		expect(tediApprovalsContract.resolveReviewManifest).toBeDefined();
	});
});

describe("approval request ids", () => {
	const resolveInput = () =>
		tediApprovalsContract.resolve["~orpc"].inputSchemas[0]!;
	const toolReviewId = `tool-review-${"a".repeat(64)}`;

	it("lets an approver resolve a tool-change review by its digest id", () => {
		expect(
			resolveInput().safeParse({ id: toolReviewId, status: "approved" })
				.success,
		).toBe(true);
		expect(
			resolveInput().safeParse({
				id: "019d0000-0000-7000-8000-000000000001",
				status: "rejected",
			}).success,
		).toBe(true);
	});

	it("still rejects ids that are neither a UUID nor a tool-review digest", () => {
		for (const id of ["tool-review-abc", "abc12345", `x${toolReviewId}`])
			expect(resolveInput().safeParse({ id, status: "approved" }).success).toBe(
				false,
			);
	});
});
