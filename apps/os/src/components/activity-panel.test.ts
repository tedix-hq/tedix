import criticalActions from "@tedix/api-contract/assets/critical-actions.v1.json";
import type { ApprovalRequest } from "@tedix/api-contract/contracts/tedi-approvals";
import type { ActivityItem } from "@tedix/api-contract/schemas/analytics";
import { describe, expect, it } from "vite-plus/test";
import {
	automaticCoverage,
	PERSON_ONLY_LABELS,
	savedRuleTitle,
} from "./activity-auto-approval";
import {
	actionHistoryEntries,
	approvalHistoryEntries,
	filterHistory,
	isAutomaticApproval,
} from "./activity-history";

const approval = (
	overrides: Partial<Omit<ApprovalRequest, "payload">> & {
		payload?: Record<string, unknown>;
	},
) =>
	({
		id: "approval-1",
		tediId: "tedi-cfo",
		orgId: "org",
		actionType: "home.tool_write",
		description: "Run work.create_work_items",
		payload: {
			appSlug: "tedix-unified",
			toolName: "work.create_work_items",
			conversationId: "home:main",
		},
		status: "approved",
		createdAt: "2026-10-24T10:00:00.000Z",
		expiresAt: "2026-10-25T10:00:00.000Z",
		resolvedAt: "2026-10-24T10:05:00.000Z",
		resolvedBy: "user-1",
		resolution: "Approved as shown",
		workflowId: null,
		review: { summary: "" },
		...overrides,
	}) as ApprovalRequest;

describe("auto-approval policy copy", () => {
	it("names every class that always asks a person", () => {
		for (const rule of criticalActions.classes)
			expect(PERSON_ONLY_LABELS[rule.id], rule.id).toBeTruthy();
	});

	it("lists what the policy approved on its own, most frequent first", () => {
		expect(
			automaticCoverage([
				approval({ resolvedBy: "policy" }),
				approval({ id: "2", resolvedBy: "policy" }),
				approval({
					id: "3",
					resolution: "auto-approved by rule 1",
					payload: { appSlug: "example-crm", toolName: "crm.add_note" },
				}),
				approval({ id: "4" }),
			]),
		).toEqual([
			{ label: "Create work items", count: 2 },
			{ label: "Add note in Example Crm", count: 1 },
		]);
	});

	it("words a saved rule as the action it allows", () => {
		expect(
			savedRuleTitle({
				actionKind: "home.tool_write",
				toolSlug: "google-drive-tedix.google_drive.create_file",
				verb: "create",
			}),
		).toBe("Create file in Google Drive");
	});
});

describe("activity history", () => {
	const tediNames = { "tedi-cfo": "CFO" };

	it("separates automatic approvals from people's decisions", () => {
		expect(isAutomaticApproval(approval({ resolvedBy: "policy" }))).toBe(true);
		expect(isAutomaticApproval(approval({}))).toBe(false);
		const entries = approvalHistoryEntries(
			[
				approval({ resolvedBy: "policy" }),
				approval({ id: "2", status: "rejected" }),
				approval({ id: "3", status: "expired", resolvedAt: null }),
				approval({ id: "4", status: "pending" }),
			],
			tediNames,
		);
		expect(entries.map((entry) => [entry.filter, entry.status.label])).toEqual([
			["automatic", "Auto-approved"],
			["approvals", "Rejected"],
			["approvals", "Expired"],
		]);
		expect(entries[0]).toMatchObject({
			title: "Create work items",
			who: "CFO",
			href: { to: "/chat?conversation=home%3Amain" },
		});
	});

	it("shows what happened after an approved gateway call ran", () => {
		const parked = {
			actionType: "mcp.tool_call",
			description:
				"Delete descope aih mcp client. Nothing has run yet; approving runs this exact call once.",
		};
		const [done, failed, waiting] = approvalHistoryEntries(
			[
				approval({
					...parked,
					payload: {
						kind: "mcp_tool_call",
						appSlug: "connect",
						execution: { status: "executed", summary: "Client deleted" },
					},
				}),
				approval({
					...parked,
					id: "2",
					payload: {
						kind: "mcp_tool_call",
						appSlug: "connect",
						execution: {
							status: "failed",
							error: "Tool is no longer available on example-unified",
						},
					},
				}),
				approval({
					...parked,
					id: "3",
					payload: { kind: "mcp_tool_call", appSlug: "connect" },
				}),
			],
			tediNames,
		);
		expect(done).toMatchObject({
			status: { label: "Done" },
			how: "Done: Client deleted",
		});
		expect(failed?.how).toBe(
			"Failed: Tool is no longer available on example-unified",
		);
		expect(waiting?.how).toBe("Decided by a person");
	});

	it("shows failed and blocked tool calls as actions", () => {
		const base = {
			timestamp: "2026-10-24T11:00:00.000Z",
			actor: { label: "Example Person" },
			subject: null,
			agent: { label: "CFO" },
			action: "mcp.tool.execute",
			success: false,
			toolName: "crm.add_note",
			tool: null,
			app: { id: "app-1", label: "Example CRM" },
			traceId: "trace-1",
			executionId: null,
			errorCode: "TIMEOUT",
			securityDecision: { disposition: "executed", denialReason: null },
		} as unknown as ActivityItem;
		const [failed, blocked] = actionHistoryEntries([
			base,
			{
				...base,
				securityDecision: {
					...base.securityDecision,
					disposition: "denied",
					denialReason: "scope missing",
				},
			},
		]);
		expect(failed).toMatchObject({
			filter: "actions",
			status: { label: "Failed" },
			title: "Add note",
			who: "CFO",
			where: "Example CRM",
			how: "It failed",
		});
		expect(blocked?.status.label).toBe("Blocked");
	});

	it("filters and sorts newest first", () => {
		const entries = approvalHistoryEntries(
			[
				approval({ id: "old", resolvedAt: "2026-10-20T00:00:00.000Z" }),
				approval({ id: "new", resolvedBy: "policy" }),
			],
			tediNames,
		);
		expect(filterHistory(entries, "all").map((entry) => entry.key)).toEqual([
			"approval:new",
			"approval:old",
		]);
		expect(filterHistory(entries, "automatic")).toHaveLength(1);
		expect(filterHistory(entries, "actions")).toHaveLength(0);
	});
});
