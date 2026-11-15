import type { WorkspaceUnreadList } from "@tedix/api-contract/schemas/workspace-unread";

const kinds = [
	"file",
	"agent_reply",
	"message",
	"needs_decision",
	"agent_stopped",
] as const;

/**
 * Thirty unread rows in three workspaces, one with a long unbroken name and
 * every file with a long unbroken title: the widest content the Unread tab
 * shows. The popover fixture seeds it; the spec serves it to the refetch.
 */
export function unreadFixture(now: number): WorkspaceUnreadList {
	const at = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
	const groups = [
		"Quarterly_planning_workspace_for_the_example_customer_onboarding_programme",
		"Example GmbH sales and finance",
		"Ops",
	].map((workspaceName, group) => ({
		workspaceId: `00000000-0000-4000-8000-00000000010${group}`,
		workspaceName,
		latestAt: at(group),
		items: Array.from({ length: 10 }, (_, index) => ({
			id: `${group}-${index}`,
			kind: kinds[index % kinds.length]!,
			byAgent: index % 2 === 0,
			actorId: "actor",
			occurredAt: at(group + index / 10),
			outputId: `00000000-0000-4000-8000-0000000002${group}${index}`,
			title:
				"October_board_review_with_revenue_forecast_and_hiring_plan_final_v12.xlsx",
		})),
	}));
	return { total: 30, groups };
}
