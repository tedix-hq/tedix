import { describe, expect, it } from "vite-plus/test";
import { decisionTrace, expertiseRadar } from "./visualization";

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
