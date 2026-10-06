import { describe, expect, it } from "vite-plus/test";
import { approvalsFromRunSet } from "./chat-cards";
import {
	approvalAttentionCount,
	isActionableHomeApproval,
} from "./approval-notifications";

describe("approvalAttentionCount", () => {
	it("combines Home and runtime decisions without crossing their authorities", () => {
		expect(approvalAttentionCount({ home: 2, runtime: 3 })).toBe(5);
	});
});

describe("isActionableHomeApproval", () => {
	it("keeps only live approve-or-reject decisions", () => {
		expect(isActionableHomeApproval({})).toBe(true);
		expect(
			isActionableHomeApproval({ decisionMode: "approve_or_reject" }),
		).toBe(true);
		expect(isActionableHomeApproval({ decisionMode: "no_action" })).toBe(false);
		expect(isActionableHomeApproval({ expired: true })).toBe(false);
	});
});

describe("terminal Home proposal attention", () => {
	it.each(["completed", "failed", "canceled"] as const)(
		"does not count a retained %s draft as an operator decision",
		(status) => {
			const recommendations = approvalsFromRunSet({
				runs: [
					{
						id: "home-run",
						organizationId: "org",
						conversationId: "home:main",
						status,
						createdAt: "2026-10-05T10:00:00.000Z",
						metadata: {
							homeDelegation: {
								decision: { mode: "needs_approval" },
								workOrder: { targetTediId: "cto", status: "draft" },
							},
						},
					},
				],
				approvalMirrors: {},
			});
			expect(recommendations).toHaveLength(1);
			expect(
				approvalAttentionCount({
					home: recommendations.filter(isActionableHomeApproval).length,
					runtime: 0,
				}),
			).toBe(0);
		},
	);
	it("retains genuine child approval mirrors even when the parent has ended", () => {
		const cards = approvalsFromRunSet({
			runs: [
				{
					id: "home-run",
					organizationId: "org",
					conversationId: "home:main",
					status: "completed",
					childRunId: "child-run",
					createdAt: "2026-10-05T10:00:00.000Z",
				},
			],
			approvalMirrors: {
				"child-run": {
					id: "child-mirror",
					parentConversationId: "home:main",
					childRunId: "child-run",
					approvalRequestId: "child-approval",
					delegatedTediId: "cto",
					status: "pending",
					blockedAt: "2026-10-05T10:00:01.000Z",
					escalateAt: 900,
				},
			},
		});
		expect(cards.filter(isActionableHomeApproval)).toHaveLength(1);
		expect(cards[0]?.approvalId).toBe("child-approval");
	});
});
