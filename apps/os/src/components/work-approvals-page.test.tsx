import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import {
	approvalOutcome,
	runtimeApprovalItem,
} from "@/components/approval-inbox";
import {
	operationalContextQueryOptions,
	pendingApprovalsQueryOptions,
	pendingHomeDelegationsQueryOptions,
	tediNamesQueryOptions,
	workPendingApprovalsQueryOptions,
} from "@/lib/os-query-options";
import { expiryLabel, WorkApprovalsPage } from "./work-approvals-page";

const HOUR = 3_600_000;

function runtimeRequest(index: number, expiresInHours: number) {
	const expiresAt = new Date(Date.now() + expiresInHours * HOUR).toISOString();
	return {
		id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
		tediId: "example-tedi",
		orgId: "example-org",
		actionType: "home.tool_write",
		description: `Create work items — title: Example task ${index}`,
		payload: {
			kind: "home_tool_write",
			appSlug: "example-unified",
			toolName: "work.create_work_items",
			riskTier: "medium",
			conversationId: `home:os:example-${index}`,
			args: { title: `Example task ${index}`, projectId: "example-project" },
		},
		status: "pending",
		createdAt: new Date(Date.now() - HOUR).toISOString(),
		expiresAt,
		resolvedAt: null,
		resolvedBy: null,
		resolution: null,
		workflowId: null,
		review: {
			intent: "tool_write",
			state: "requires_decision",
			decisionMode: "approve_or_reject",
			outcome: null,
			safetyDefault: "deny_on_timeout",
			summary: `Create work items — title: Example task ${index}`,
			operatorQuestion: "Approve or reject this Home tool write.",
			timeout: {
				expired: expiresInHours < 0,
				terminalStatus: null,
				defaultDecision: null,
				reason: "",
			},
			evidenceRefs: [],
			interaction: null,
		},
	};
}

function renderPage(requests: unknown[]) {
	const client = new QueryClient();
	client.setQueryData<unknown>(operationalContextQueryOptions().queryKey, {
		authority: { role: "owner", permissions: ["os:approve"] },
	});
	client.setQueryData<unknown>(pendingApprovalsQueryOptions().queryKey, {
		data: requests,
		pagination: {
			limit: 100,
			offset: 0,
			total: requests.length,
			hasMore: false,
		},
	});
	client.setQueryData<unknown>(pendingHomeDelegationsQueryOptions().queryKey, {
		runSet: { runs: [], approvalMirrors: {} },
	});
	client.setQueryData<unknown>(workPendingApprovalsQueryOptions().queryKey, {
		data: [],
	});
	client.setQueryData<unknown>(tediNamesQueryOptions().queryKey, {
		data: [{ id: "example-tedi", name: "Example tedi" }],
	});
	const html = renderToStaticMarkup(
		<QueryClientProvider client={client}>
			<WorkApprovalsPage />
		</QueryClientProvider>,
	);
	client.clear();
	return html;
}

describe("Approvals page", () => {
	it("shows every waiting request as its own card with a matching count", () => {
		const requests = Array.from({ length: 25 }, (_, index) =>
			runtimeRequest(index, 25 - index),
		);
		const html = renderPage(requests);
		expect(html.match(/data-approval-card=""/g)).toHaveLength(25);
		expect(html).toContain("25 waiting");
		for (let index = 0; index < 25; index += 1)
			expect(html).toContain(`Title: Example task ${index}`);
		// Soonest expiry first: task 24 expires in 1 h, task 0 in 25 h.
		expect(html.indexOf("Example task 24")).toBeLessThan(
			html.indexOf("Example task 0<"),
		);
	});

	it("speaks plain English with one-tap decisions", () => {
		const html = renderPage([runtimeRequest(1, 20)]);
		expect(html).toContain("Create work items");
		expect(html).toContain("Asked by Example tedi in Example");
		expect(html).toContain("expires in 20h");
		expect(html).toContain(">Approve<");
		expect(html).toContain(">Reject<");
		expect(html).toContain("Ask the tedi");
		for (const jargon of [
			"Decide for me",
			"Choose veto",
			"Remove from review",
			"Review selected requests",
			"hard dependency graph",
			"of 25 selected",
			"technical details",
		])
			expect(html).not.toContain(jargon);
	});

	it("keeps expired requests out of the waiting list with a clear action", () => {
		const html = renderPage([runtimeRequest(1, 5), runtimeRequest(2, -30)]);
		expect(html.match(/data-approval-card=""/g)).toHaveLength(1);
		expect(html).toContain("1 waiting");
		expect(html).toContain("Expired · 1");
		expect(html).toContain("Clear expired");
	});
});

describe("expiryLabel", () => {
	it("reads as a countdown, then as past", () => {
		const now = new Date("2026-10-25T22:00:00Z");
		expect(expiryLabel("2026-10-26T18:00:00Z", now)).toBe("expires in 20h");
		expect(expiryLabel("2026-10-25T19:00:00Z", now)).toBe("expired 3h ago");
	});
});

describe("approvalOutcome", () => {
	it("says what happened and what happens next", () => {
		const item = runtimeApprovalItem(
			runtimeRequest(3, 4) as Parameters<typeof runtimeApprovalItem>[0],
			{},
		);
		expect(approvalOutcome([item], "approved").message).toBe(
			"Approved: Create work items. The change runs now.",
		);
		expect(approvalOutcome([item, item], "rejected").message).toBe(
			"Rejected: 2 requests: Create work items. Nothing ran.",
		);
	});
	it("reports how an approved tool call ran, from the resolved request", () => {
		const request = runtimeRequest(5, 4);
		const item = runtimeApprovalItem(
			{
				...request,
				actionType: "mcp.tool_call",
				description: "Delete descope aih mcp client",
				payload: {
					kind: "mcp_tool_call",
					appSlug: "example-unified",
					toolId: "tedix__delete_descope_aih_mcp_client",
					args: { id: "TPA-1" },
				},
				review: { ...request.review, summary: "Delete descope aih mcp client" },
			} as Parameters<typeof runtimeApprovalItem>[0],
			{},
		);
		expect(item.afterApprove).toBe("It runs once now.");
		expect(approvalOutcome([item], "approved").message).toBe(
			"Approved: Delete descope aih mcp client. It runs once now.",
		);
		expect(
			approvalOutcome([item], "approved", [
				{ status: "executed", startedAt: "x", summary: "Client deleted" },
			]).message,
		).toBe("Done: Delete descope aih mcp client. Client deleted.");
		expect(
			approvalOutcome([item, item], "approved", [
				{ status: "executed", startedAt: "x" },
				{
					status: "failed",
					startedAt: "x",
					error: "Provider tool call failed (transport)",
					retryable: true,
				},
			]).message,
		).toBe(
			"Failed: 1 of 2 requests: Delete descope aih mcp client. Provider tool call failed (transport). Try again from Activity.",
		);
		expect(
			approvalOutcome([item], "approved", [
				{
					status: "failed",
					startedAt: "x",
					error: "insufficient_scope: platform:admin",
					retryable: false,
				},
			]).message,
		).toBe(
			"Failed: Delete descope aih mcp client. insufficient_scope: platform:admin. Request a new approval.",
		);
	});
});
