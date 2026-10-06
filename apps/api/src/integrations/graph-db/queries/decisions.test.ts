import { describe, expect, it } from "vite-plus/test";
import { findDecisionsWithSharedEvidence } from "./decisions";

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
