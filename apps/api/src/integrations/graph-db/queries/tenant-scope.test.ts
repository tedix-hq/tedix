import { describe, expect, it } from "vite-plus/test";
import { findStructurallySimilar, getNeighborhoodSimple } from "./facts";
import { findDecisionsWithSharedEvidence } from "./decisions";
import {
	crossTediFlow,
	decisionTrace,
	expertiseRadar,
	knowledgeMap,
} from "./visualization";

describe("tenant-scoped fact graph roots", () => {
	it("binds structural and neighborhood root identities to the organization", () => {
		expect(findStructurallySimilar("fact-1", "org-1").query).toContain(
			"MATCH (target:Fact {id: $factId, orgId: $orgId})",
		);
		expect(getNeighborhoodSimple("fact-1", 2, "org-1").query).toContain(
			"(start:Fact {id: $factId, orgId: $orgId})",
		);
		expect(getNeighborhoodSimple("fact-1", 2, "org-1").query).toContain(
			"all(n IN nodes(path) WHERE n:Fact",
		);
		expect(getNeighborhoodSimple("fact-1", 2, "org-1").query).toContain(
			"type(r) IN $allowedRelationTypes",
		);
	});

	it("keeps visualization domain joins in one tenant", () => {
		expect(knowledgeMap({ orgId: "org-1" }).query).toContain(
			"OPTIONAL MATCH (f)-[:IN_DOMAIN]->(d:Domain {orgId: $orgId})",
		);
		const flow = crossTediFlow("org-1").query;
		expect(flow).toContain(
			"OPTIONAL MATCH (tedi)-[e:EXPERT_IN]->(d:Domain {orgId: $orgId})",
		);
		expect(flow).toContain(
			"OPTIONAL MATCH (shared)-[:IN_DOMAIN]->(domain:Domain {orgId: $orgId})",
		);
	});
});

describe("decision queries", () => {
	it("tenant-scopes the source decision in shared-evidence traversal", () => {
		const result = findDecisionsWithSharedEvidence("decision-1", "org-1", 5);

		expect(result.query).toContain(
			"MATCH (source:Decision {id: $decisionId, orgId: $orgId})",
		);
		expect(result.params).toMatchObject({
			decisionId: "decision-1",
			orgId: "org-1",
			topK: 5,
		});
	});
});

describe("tenant-scoped graph visualizations", () => {
	it("binds decision traces to the caller organization", () => {
		const query = decisionTrace("decision-1", "org-1");
		expect(query.params).toMatchObject({
			decisionId: "decision-1",
			orgId: "org-1",
		});
		expect(query.query).toContain(
			"MATCH (d:Decision {id: $decisionId, orgId: $orgId})",
		);
	});

	it("binds both tedi and domain roots to the caller organization", () => {
		const query = expertiseRadar("tedi-1", "org-1");
		expect(query.params).toMatchObject({ tediId: "tedi-1", orgId: "org-1" });
		expect(query.query).toContain(
			"MATCH (t:Tedi {id: $tediId, orgId: $orgId})-[e:EXPERT_IN]->(d:Domain {orgId: $orgId})",
		);
	});
});
