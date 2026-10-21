import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import type { WorkDecisionCard } from "./work-decision-card";

const state = vi.hoisted(() => ({
	card: undefined as Parameters<typeof WorkDecisionCard>[0] | undefined,
	create: vi.fn(async () => ({})),
	resolve: vi.fn(async () => ({})),
	invalidate: vi.fn(async () => {}),
}));
vi.mock("@tanstack/react-query", () => ({
	useQueryClient: () => ({ invalidateQueries: state.invalidate }),
	useQuery: () => ({
		data: {
			id: "approval-1",
			tediId: "tedi-1",
			status: "pending",
			actionType: "home.tool_write",
			description: "Update a note",
			createdAt: "2026-10-21",
			payload: {
				kind: "home_tool_write",
				appSlug: "notes",
				toolName: "update_note",
			},
			review: {
				decisionMode: "approve_or_reject",
				timeout: { expired: false },
				summary: "Update a note",
			},
		},
	}),
}));
vi.mock("@/lib/api", () => ({
	osApi: {
		osApprovalRules: { create: state.create },
		tediApprovals: { resolve: state.resolve },
	},
}));
vi.mock("@/lib/os-query-options", () => ({
	osQuery: {
		tediApprovals: { getById: { queryOptions: () => ({}) } },
		learningFeedback: { key: () => [] },
	},
	osQueryKeys: { approvalRules: () => [], approvals: () => [] },
}));
vi.mock("@/components/work-read-region", () => ({
	useWorkReadFailure: () => false,
	WorkReadNotice: () => null,
}));
vi.mock("@/components/work-interaction-decision-card", () => ({
	WorkInteractionDecisionCard: () => null,
}));
vi.mock("@/components/work-decision-card", () => ({
	WorkDecisionCard: (props: Parameters<typeof WorkDecisionCard>[0]) => {
		state.card = props;
		return null;
	},
}));

import { ApprovalDecisionCard } from "./work-decision-stack";

describe("Deck standing approval", () => {
	it("names the exact tool in confirmation and saves only that scope", async () => {
		renderToStaticMarkup(
			<ApprovalDecisionCard
				id="approval-1"
				onNext={() => {}}
				onPrevious={() => {}}
			/>,
		);
		const always = state.card?.actions?.find(
			(action) => action.id === "always",
		);
		expect(always?.confirm).toContain("update requests from notes.update_note");
		expect(always?.confirm).toContain(
			"Other tools and destructive actions still require review",
		);
		await state.card?.onDecision({
			action: "always",
			signal: "approve-as-is",
			body: "Update a note",
		});
		expect(state.create).toHaveBeenCalledWith({
			actionKind: "home.tool_write",
			toolSlug: "notes.update_note",
			verb: "update",
		});
		expect(state.resolve).toHaveBeenCalledWith(
			expect.objectContaining({ id: "approval-1", status: "approved" }),
		);
	});
});
