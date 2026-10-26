import { expect, it } from "vite-plus/test";
import { ActivityFeedItemSchema } from "@tedix/api-contract/schemas/os-activity-feed";
import { workFeedItems } from "@tedix/api-contract/utils/activity-feed";
import { timelineItems } from "@tedix/api-contract/utils/feed-story";

it("shows an enrolled agent's fictional finding as one Feed post with provenance and canonical Work receipt", () => {
	const id = "11111111-1111-4111-8111-111111111111";
	const contribution = {
		sourceAgentId: id,
		sourceAgentName: "Cedar Scout",
		imageUrl: "https://assets.example.test/cedar.svg",
		representedUserId: "fictional-luz",
		sourceChannel: "browser_form" as const,
		capturedAt: "2026-10-19T12:00:00.000Z",
		evidenceUrl: "https://cedar.example/findings/one",
		externalFindingId: "cedar-one",
		kind: "fyi" as const,
	};
	const event = {
		id,
		workItemId: id,
		workItemTitle: "A useful finding",
		workItemDisposition: "proposed" as const,
		eventType: "personal_agent.finding_received",
		authorType: "system",
		authorId: `personal-agent:${id}`,
		agentSession: null,
		agentHarness: null,
		settlement: null,
		body: "A useful finding",
		createdAt: contribution.capturedAt,
		personalAgentContribution: contribution,
	};
	const rows = workFeedItems([event], null);
	expect(rows).toHaveLength(1);
	expect(rows[0]?.actorIdentity).toMatchObject({
		type: "system",
		id: `personal-agent:${id}`,
		contributor: {
			id,
			displayName: "Cedar Scout",
			representedUserId: "fictional-luz",
			imageUrl: contribution.imageUrl,
		},
		source: {
			channel: "browser_form",
			evidenceUrl: contribution.evidenceUrl,
			externalFindingId: "cedar-one",
		},
	});
	const row = ActivityFeedItemSchema.parse(rows[0]);
	expect(row).toMatchObject({
		actor: "Cedar Scout",
		personalAgentContribution: contribution,
		kind: "signal",
		importance: "normal",
		source: `/work/items/${id}`,
		needsAction: false,
		done: false,
	});
	expect(row.explanation).toContain("for you. FYI; no action executed");
	expect(row.explanation).toContain(contribution.evidenceUrl);
	expect(timelineItems(rows)).toHaveLength(1);
});
