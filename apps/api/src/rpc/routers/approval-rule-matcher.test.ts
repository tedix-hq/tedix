import type { DbQueryClient } from "@tedix/db/query-client";
import { describe, expect, it, vi } from "vite-plus/test";
import { DESTRUCTIVE_VERBS } from "./kernel/write-tool-policy";
import {
	findApprovalRule,
	matchingApprovalRule,
} from "./approval-rule-matcher";

const rule = {
	id: "rule-1",
	organizationId: "org-1",
	actionKind: "home.tool_write",
	toolSlug: "notes.update_note",
	verb: "update",
	decision: "approve" as const,
	enabled: true,
	createdByKind: "user" as const,
	createdById: "user-1",
	createdAt: "2026-01-01",
	disabledAt: null,
};
const approval = {
	orgId: "org-1",
	actionType: "home.tool_write",
	payload: {
		kind: "home_tool_write",
		appSlug: "notes",
		toolName: "update_note",
		args: {},
		riskTier: "low",
	},
};

describe("standing approval matching", () => {
	it("matches the exact tool and verb without covering another tool or tenant", () => {
		expect(matchingApprovalRule(approval, [rule])?.id).toBe(rule.id);
		expect(
			matchingApprovalRule(
				{
					...approval,
					payload: { ...approval.payload, toolName: "create_note" },
				},
				[rule],
			),
		).toBeUndefined();
		expect(
			matchingApprovalRule({ ...approval, orgId: "org-2" }, [rule]),
		).toBeUndefined();
		expect(
			matchingApprovalRule(approval, [{ ...rule, verb: "create" }]),
		).toBeUndefined();
		expect(
			matchingApprovalRule(approval, [{ ...rule, enabled: false }]),
		).toBeUndefined();
	});
	it("does not revive legacy broad Home rules", () => {
		expect(
			matchingApprovalRule(approval, [{ ...rule, toolSlug: null, verb: null }]),
		).toBeUndefined();
	});
	it.each([...DESTRUCTIVE_VERBS, "deploy", "live_view_takeover"])(
		"never approves %s even with an exact rule",
		(verb) => {
			const toolName = `${verb}_note`;
			expect(
				matchingApprovalRule(
					{ ...approval, payload: { ...approval.payload, toolName } },
					[{ ...rule, toolSlug: `notes.${toolName}`, verb }],
				),
			).toBeUndefined();
		},
	);
	it("rejects high risk and arbitrary code execution", () => {
		expect(
			matchingApprovalRule(
				{ ...approval, payload: { ...approval.payload, riskTier: "high" } },
				[rule],
			),
		).toBeUndefined();
		// Medium risk and an unclassified payload stay with a human too.
		expect(
			matchingApprovalRule(
				{ ...approval, payload: { ...approval.payload, riskTier: "medium" } },
				[rule],
			),
		).toBeUndefined();
		const { riskTier: _riskTier, ...unclassified } = approval.payload;
		expect(
			matchingApprovalRule({ ...approval, payload: unclassified }, [rule]),
		).toBeUndefined();
		expect(
			matchingApprovalRule(
				{
					...approval,
					payload: { ...approval.payload, kind: "codemode_execute_write" },
				},
				[rule],
			),
		).toBeUndefined();
	});
	it.each(["deploy", "browser.live_view_takeover"])(
		"never approves action %s through a broad rule",
		(actionType) => {
			expect(
				matchingApprovalRule({ ...approval, actionType }, [
					{ ...rule, actionKind: actionType, toolSlug: null, verb: null },
				]),
			).toBeUndefined();
		},
	);
	it("preserves broad non-tool sweep rules", () => {
		expect(
			matchingApprovalRule(
				{ orgId: "org-1", actionType: "cron_job", payload: {} },
				[{ ...rule, actionKind: "cron_job", toolSlug: null, verb: null }],
			)?.id,
		).toBe(rule.id);
	});
});

it("rejects a reused approval from another organization before reading standing authority", async () => {
	const select = vi.fn();
	const db = { select } as unknown as DbQueryClient;
	expect(await findApprovalRule(db, approval, "org-2")).toBeUndefined();
	expect(select).not.toHaveBeenCalled();
});
