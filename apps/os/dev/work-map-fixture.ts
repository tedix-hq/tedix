import type { WorkMap } from "@tedix/api-contract/schemas/work-map";
import { ORG_ID } from "./local-fixtures/core";

/** Sample Work Map: one epic tree, a down supervisor and a stalled item. */
export function workMapFixture(now = new Date()): WorkMap {
	const ago = (hours: number) =>
		new Date(now.getTime() - hours * 3_600_000).toISOString();
	const epic = {
		disposition: "accepted" as const,
		parentId: null,
		projectId: "project-eu",
		objectiveId: "goal-eu",
	};
	const item = (
		id: string,
		title: string,
		disposition: "accepted" | "completed",
	) => ({
		id,
		title,
		disposition,
		priority: "medium" as const,
		parentId: "epic-eu",
		projectId: "project-eu",
		objectiveId: "goal-eu",
		executor: "codex",
		attemptState: null,
		lastEventAt: ago(disposition === "completed" ? 30 : 20),
		signals: [] as WorkMap["items"][number]["signals"],
	});
	const stalled = item(
		"item-eu-2",
		"Move customer tables to the EU",
		"accepted",
	);
	stalled.signals = [
		{
			kind: "stalled",
			reason:
				"No event for 20 hours; the last blocker is the EU database not yet created.",
			since: ago(20),
			actor: { type: "user", id: "aaron" },
		},
	];
	return {
		organizationId: ORG_ID,
		readAt: now.toISOString(),
		stalledAfterHours: 12,
		truncated: false,
		objectives: [{ id: "goal-eu", title: "Keep customer data in the EU" }],
		projects: [
			{ id: "project-eu", name: "EU data layout", objectiveId: "goal-eu" },
		],
		epics: [
			{
				...epic,
				id: "epic-eu",
				title: "EU data layout",
				progress: {
					total: 2,
					completed: 1,
					cancelled: 0,
					open: 1,
					percentDone: 0.5,
				},
			},
		],
		items: [item("item-eu-1", "Choose the EU region", "completed"), stalled],
		lanes: [
			{
				id: "local:supervisor",
				reporterId: "local",
				kind: "supervisor",
				executor: "supervisor",
				lane: "supervisor",
				state: "down",
				reason: "No heartbeat: the supervisor stopped or its sign-in failed.",
				reportedAt: ago(0.1),
				ageSeconds: 360,
				downAfterSeconds: 45,
				slotsInUse: 0,
				slotsTotal: 0,
				heartbeat: true,
			},
		],
		notMoving: [
			{
				workItemId: stalled.id,
				title: stalled.title,
				kind: "stalled",
				blocker: stalled.signals[0]!.reason,
				since: ago(20),
				actor: { type: "user", id: "aaron" },
			},
		],
	};
}
