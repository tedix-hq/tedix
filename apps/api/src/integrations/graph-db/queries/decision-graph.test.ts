import { describe, expect, it } from "vite-plus/test";
import {
	blocksReachQuery,
	decisionGraphRelationshipType,
	deleteDecisionGraphEdgesQuery,
	duplicateCommunityQuery,
	groupDecisionGraphEdges,
	upsertDecisionGraphEdgesQuery,
} from "./decision-graph";

describe("decision graph Cypher", () => {
	it("maps only allowlisted edge kinds to relationship types", () => {
		expect(decisionGraphRelationshipType("blocks")).toBe("DG_BLOCKS");
		expect(decisionGraphRelationshipType("same_as")).toBe("DG_SAME_AS");
		expect(() =>
			decisionGraphRelationshipType("x]->() DETACH DELETE n //" as never),
		).toThrow("Unknown decision graph edge kind");
	});

	it("groups edges per kind with org-scoped node keys", () => {
		const groups = groupDecisionGraphEdges([
			{
				id: "edge-1",
				orgId: "org-1",
				kind: "blocks",
				fromKind: "work_item",
				fromId: "work-a",
				toKind: "work_item",
				toId: "work-b",
				confidence: 1,
				note: null,
				occurredAt: "2026-10-21T08:00:00.000Z",
			},
		]);
		expect([...groups.keys()]).toEqual(["DG_BLOCKS"]);
		expect(groups.get("DG_BLOCKS")?.[0]).toMatchObject({
			fromKey: "work_item:work-a",
			toKey: "work_item:work-b",
			orgId: "org-1",
		});
	});

	it("roots every read and write at an org-scoped DecisionNode", () => {
		for (const query of [
			upsertDecisionGraphEdgesQuery("DG_BLOCKS"),
			deleteDecisionGraphEdgesQuery("DG_BLOCKS"),
		]) {
			expect(query).toContain(
				"DecisionNode {orgId: row.orgId, key: row.fromKey}",
			);
		}
		expect(blocksReachQuery().query).toContain(
			"(blocked:DecisionNode {orgId: $orgId})",
		);
		expect(blocksReachQuery().query).toContain("[:DG_BLOCKS*1..4]");
		expect(blocksReachQuery().query).toContain("all(node IN nodes(path)");
		expect(blocksReachQuery().query).toContain(
			"work.disposition IN ['completed', 'cancelled']",
		);
		expect(duplicateCommunityQuery().query).toContain(
			"(card:DecisionNode {orgId: $orgId, key: 'deck_card:' + cardId})",
		);
	});
});
