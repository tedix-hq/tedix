import { describe, expect, it } from "vite-plus/test";
import { decideAutoApproval } from "./approval-policy";

const inputs: Parameters<typeof decideAutoApproval>[0][] = [
	{
		kind: "autonomy",
		policy: { version: 1, maxRisk: "medium" },
		risk: "low",
		content: "Update note",
	},
	{
		kind: "kernel_write",
		policy: { writeTier: { trustedTools: ["notes:update_note"] } },
		proposal: { appSlug: "notes", toolName: "update_note", riskTier: "low" },
	},
	{
		kind: "standing_rule",
		organizationId: "example",
		actionType: "home.tool_write",
		payloadKind: "home_tool_write",
		riskTier: "low",
		declaredClass: null,
		toolSlug: "notes.update_note",
		verb: "update",
		forbiddenName: false,
		rules: [
			{
				id: "rule-note",
				organizationId: "example",
				actionKind: "home.tool_write",
				toolSlug: "notes.update_note",
				verb: "update",
				decision: "approve",
				enabled: true,
			},
		],
	},
	{
		kind: "learned_class",
		classId: "note",
		autoApproveClasses: ["note"],
		ready: true,
	},
	{
		kind: "platform",
		toolName: "create_work_item",
		endpoint: "workItems/create",
		policy: {},
		classId: "tool:work:create_work_item",
	},
	{
		kind: "gateway",
		eligible: true,
		ruleId: "grant",
		reason: "durable grant grant-1",
	},
];

describe("shared automatic approval", () => {
	it.each(inputs)("returns one reason for $kind", (input) => {
		expect(decideAutoApproval(input)).toMatchObject({
			autoApprove: true,
			reason: expect.any(String),
		});
	});
	it.each(inputs)("the latch overrides $kind", (input) => {
		for (const sensitiveData of ["latched", "unavailable"] as const)
			expect(decideAutoApproval({ ...input, sensitiveData })).toMatchObject({
				autoApprove: false,
				reason: expect.stringContaining("sensitive_data_latch"),
			});
	});
	it("keeps learned classes and corrections gated", () => {
		expect(
			decideAutoApproval({
				kind: "learned_class",
				classId: "note",
				autoApproveClasses: [],
				ready: true,
			}).autoApprove,
		).toBe(false);
		expect(
			decideAutoApproval({
				kind: "learned_class",
				classId: "note",
				autoApproveClasses: ["note"],
				ready: false,
			}).autoApprove,
		).toBe(false);
		expect(
			decideAutoApproval({
				kind: "platform",
				toolName: "create_work_item",
				endpoint: "workItems/create",
				policy: {
					autonomy: { version: 1, maxRisk: "medium", askForClasses: ["*"] },
				},
				classId: "tool:work:create_work_item",
			}).autoApprove,
		).toBe(false);
	});
});
