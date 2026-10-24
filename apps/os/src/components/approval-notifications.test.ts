import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import {
	homeRunSetQueryOptions,
	operationalContextQueryOptions,
	pendingApprovalsQueryOptions,
	pendingHomeDelegationsQueryOptions,
	tediNamesQueryOptions,
} from "@/lib/os-query-options";
import { approvalsFromRunSet } from "./chat-cards";
import {
	type ApprovalListItem,
	approvalAttentionCount,
	ApprovalNotifications,
	approvalGroupHeadingClassName,
	collapseIdenticalItems,
	delegationHoldChip,
	groupApprovalItems,
	isActionableHomeApproval,
	isActionableRuntimeApproval,
} from "./approval-notifications";

describe("approval popover authority", () => {
	it.each([
		{ permissions: undefined, count: 0 },
		{ permissions: ["tedis:update"], count: 0 },
		{ permissions: ["os:approve"], count: 2 },
		{ permissions: ["settings:manage"], count: 2 },
	])(
		"counts only decisions this account can make: $permissions",
		({ permissions, count }) => {
			const client = new QueryClient();
			// Cache fixtures contain the render inputs; unrelated API metadata is omitted.
			// Without a context entry, authority is genuinely still loading.
			if (permissions) {
				client.setQueryData<unknown>(
					operationalContextQueryOptions().queryKey,
					{
						authority: { role: "member", permissions },
					},
				);
			}
			client.setQueryData<unknown>(
				homeRunSetQueryOptions("home:example").queryKey,
				{
					runSet: {
						runs: [
							{
								id: "example-run",
								status: "requires_approval",
								metadata: {
									approvalRequestId: "home-write",
									kernelWriteProposal: {
										appSlug: "example",
										toolName: "update_record",
										args: {},
									},
								},
							},
						],
						approvalMirrors: {},
					},
				},
			);
			client.setQueryData<unknown>(
				pendingHomeDelegationsQueryOptions().queryKey,
				{
					runSet: { runs: [], approvalMirrors: {} },
				},
			);
			client.setQueryData<unknown>(pendingApprovalsQueryOptions().queryKey, {
				data: [
					{
						id: "runtime-write",
						tediId: "example-worker",
						actionType: "tool_write",
						description: "A saved example change",
						payload: {},
						review: {
							summary: "Example write",
							intent: "tool_write",
							decisionMode: "approve_or_reject",
							timeout: { expired: false },
						},
					},
				],
			});
			client.setQueryData<unknown>(tediNamesQueryOptions().queryKey, {
				data: [],
			});
			const html = renderToStaticMarkup(
				createElement(
					QueryClientProvider,
					{ client },
					createElement(ApprovalNotifications, {
						conversationId: "home:example",
					}),
				),
			);
			expect(html).toContain(
				count === 0
					? "Action approvals: none waiting"
					: `Action approvals: ${count} waiting`,
			);
			client.clear();
		},
	);
});

describe("approval group heading", () => {
	it("wraps unbroken tedi labels within the popover", () => {
		expect(approvalGroupHeadingClassName).toContain("min-w-0");
		expect(approvalGroupHeadingClassName).toContain("break-words");
	});
});

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

describe("held delegation review window", () => {
	const heldMetadata = {
		homeDelegation: {
			decision: {
				mode: "needs_approval",
				reason: "human-reserved: money, external_message",
			},
			workOrder: {
				targetTediId: "cfo",
				targetTediLabel: "CFO",
				status: "draft",
				sourceContent:
					"[[tedix-context:output:abc:Output]]\n\nDraft the Example GmbH invoice.",
			},
			expiresAt: "2026-10-21T10:00:00.000Z",
		},
	};
	const heldRun = {
		id: "held-run",
		organizationId: "org",
		conversationId: "home:main",
		status: "requires_approval" as const,
		createdAt: "2026-10-20T10:00:00.000Z",
		metadata: heldMetadata,
	};

	it("shows the request, target and expiry while the window is open", () => {
		const [card] = approvalsFromRunSet(
			{ runs: [heldRun], approvalMirrors: {} },
			{},
			Date.parse("2026-10-20T12:00:00.000Z"),
		);
		expect(card).toMatchObject({
			tediId: "cfo",
			tediName: "CFO",
			requestPreview: "Draft the Example GmbH invoice.",
			expiresAt: "2026-10-21T10:00:00.000Z",
		});
		expect(card && isActionableHomeApproval(card)).toBe(true);
	});

	it("stops counting a request once its window has passed", () => {
		const [card] = approvalsFromRunSet(
			{ runs: [heldRun], approvalMirrors: {} },
			{},
			Date.parse("2026-10-21T10:00:01.000Z"),
		);
		expect(card?.expired).toBe(true);
		expect(card && isActionableHomeApproval(card)).toBe(false);
	});

	it("explains an expired request kept as history", () => {
		const [card] = approvalsFromRunSet({
			runs: [
				{
					...heldRun,
					status: "canceled",
					metadata: {
						...heldMetadata,
						kernelReconciliation: {
							action: "mark_expired",
							reason:
								"a newer identical request is waiting for approval (run r2)",
						},
					},
				},
			],
			approvalMirrors: {},
		});
		expect(card?.summary).toBe("Delegation approval expired");
		expect(card?.noActionNote).toContain("a newer identical request");
		expect(card && isActionableHomeApproval(card)).toBe(false);
	});
});

describe("delegationHoldChip", () => {
	it("names the reserved class in plain words", () => {
		expect(
			delegationHoldChip("human-reserved: money, external_message"),
		).toEqual({ label: "Money +1", tone: "warning" });
		expect(delegationHoldChip("human-reserved: public_publish")).toEqual({
			label: "Publishes",
			tone: "warning",
		});
		expect(delegationHoldChip("high risk requires human approval")).toEqual({
			label: "High risk",
			tone: "error",
		});
		expect(delegationHoldChip("human-reserved: delete_data")).toEqual({
			label: "Deletes data",
			tone: "warning",
		});
		expect(delegationHoldChip(null)).toEqual({
			label: "Needs review",
			tone: "secondary",
		});
	});
});

describe("isActionableRuntimeApproval", () => {
	it("counts only live approve-or-reject requests", () => {
		const review = (decisionMode: string, expired: boolean) => ({
			review: { decisionMode, timeout: { expired } },
		});
		expect(
			isActionableRuntimeApproval(review("approve_or_reject", false)),
		).toBe(true);
		expect(isActionableRuntimeApproval(review("no_action", false))).toBe(false);
		expect(isActionableRuntimeApproval(review("approve_or_reject", true))).toBe(
			false,
		);
	});
});

describe("groupApprovalItems", () => {
	it("groups by tedi, largest group first", () => {
		const item = (key: string, name: string | null) =>
			({ key, tedi: name ? { id: name, name } : null }) as ApprovalListItem;
		expect(
			groupApprovalItems([
				item("a", "CFO"),
				item("b", "CTO"),
				item("c", "CTO"),
				item("d", null),
			]).map((group) => [group.label, group.items.length]),
		).toEqual([
			["CTO", 2],
			["CFO", 1],
			["Tedix", 1],
		]);
	});
});

describe("collapseIdenticalItems", () => {
	it("decides identical requests from one tedi as one row", () => {
		const item = (key: string, title: string, tedi = "CTO") =>
			({
				key,
				title,
				kind: "Action",
				where: null,
				chip: { label: "Change", tone: "warning" },
				tedi: { id: tedi, name: tedi },
			}) as ApprovalListItem;
		expect(
			collapseIdenticalItems([
				item("a", "Create factory"),
				item("b", "Create factory"),
				item("c", "Create factory", "CFO"),
				item("d", "Update role"),
			]).map((row) => row.map((entry) => entry.key)),
		).toEqual([["a", "b"], ["c"], ["d"]]);
	});
});
