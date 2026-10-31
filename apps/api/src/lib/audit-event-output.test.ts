import { expect, it } from "vite-plus/test";
import { toAuditEventOutput, type AuditEventRow } from "./audit-event-output";
it("removes historical approval result echoes from shared audit and export projections", () => {
	for (const action of ["approval.executed", "approval.execution_failed"]) {
		const row = {
			id: "audit-example",
			organizationId: "org-1",
			actorId: "requester",
			actorType: "user",
			action,
			resourceType: "approval_request",
			resourceId: "approval-example",
			metadata: {
				source: "approvals.settleOwnerToolCallApproval",
				toolId: "example",
				summary: "private-result-marker",
				error: "private-result-marker",
				executionResult: { token: "private-result-marker" },
			},
			timestamp: new Date("2026-01-01T00:00:00Z"),
		} as AuditEventRow;
		const output = toAuditEventOutput(row);
		expect(JSON.stringify(output)).not.toContain("private-result-marker");
		expect(output.metadata).toEqual({
			source: "approvals.settleOwnerToolCallApproval",
			toolId: "example",
		});
		expect(row.metadata).toHaveProperty("executionResult");
	}
});
it("keeps unrelated audit metadata unchanged", () => {
	const metadata = { summary: "Business event" };
	expect(
		toAuditEventOutput({
			action: "workspace.created",
			metadata,
			timestamp: new Date(),
		} as AuditEventRow).metadata,
	).toBe(metadata);
});
