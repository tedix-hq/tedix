import { describe, expect, it } from "vite-plus/test";
import { findStructurallySimilar, getNeighborhoodSimple } from "./facts";
import { crossTediFlow, knowledgeMap } from "./visualization";

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
