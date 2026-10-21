import { expect, test } from "bun:test";
import { approvalHistory } from "./approval-history.mjs";

test("approval histories keep source identities, decisions and cutoff coverage", async () => {
	const queries: string[] = [];
	const r = await approvalHistory({
		workTool: "work.list_work_approvals",
		runtimeTool: "tedi.list_tedi_approvals",
		cutoff: "2026-09-21T00:00:00.000Z",
		maxPages: 5,
		checkpoint: async () => {},
		read: async (source: string) => {
			queries.push(source);
			return source.includes("work.list_work_approvals")
				? {
						data: [
							{
								proposal: {
									id: "proposal-one",
									workItemId: "work-one",
									action: "admission",
									requestedByType: "external_agent",
									requestedById: "agent-one",
									requestRationale: "Approve the bounded source change?",
									requestedAt: "2026-10-20T12:00:00.000Z",
									expiresAt: "2026-10-22T12:00:00.000Z",
								},
								effectiveStatus: "approved",
								decision: { id: "decision-one", deciderType: "user" },
								workItem: { title: "Cedar release", disposition: "completed" },
							},
						],
						hasMore: false,
						nextCursor: null,
					}
				: {
						data: [
							{
								id: "runtime-one",
								tediId: "tedi-one",
								description: "Approve Cedar tool?",
								actionType: "tool_write",
								status: "rejected",
								createdAt: "2026-10-19T12:00:00.000Z",
								expiresAt: "2026-10-20T12:00:00.000Z",
								resolvedBy: "owner-one",
								resolution: "Keep the existing result",
							},
						],
						pagination: { offset: 0, limit: 1, total: 1, hasMore: false },
					};
		},
	});
	expect(r.rows.map((x) => x.request.id)).toEqual([
		"work-approval:proposal-one",
		"approval:runtime-one",
	]);
	expect(r.rows[0]!.workItem.disposition).toBe("completed");
	expect(r.rows[0]!.sourceRecord.decision.deciderType).toBe("user");
	expect(r.rows[1]!.sourceRecord.resolution).toBe("Keep the existing result");
	expect(r.coverage.workApprovals.complete).toBe(true);
	expect(r.coverage.runtimeApprovals.complete).toBe(true);
	expect(queries[1]).toContain('"decidableOnly":true');
});

test("an approval history page bound is reported as incomplete", async () => {
	const r = await approvalHistory({
		workTool: "work.list_work_approvals",
		runtimeTool: "tedi.list_tedi_approvals",
		cutoff: "2026-09-21T00:00:00.000Z",
		maxPages: 1,
		checkpoint: async () => {},
		read: async (source: string) =>
			source.includes("work.list_work_approvals")
				? { data: [], hasMore: false, nextCursor: null }
				: {
						data: [
							{ id: "runtime-one", createdAt: "2026-10-20T00:00:00.000Z" },
						],
						pagination: { offset: 0, limit: 1, total: 2, hasMore: true },
					},
	});
	expect(r.coverage.workApprovals.complete).toBe(true);
	expect(r.coverage.runtimeApprovals.complete).toBe(false);
});
