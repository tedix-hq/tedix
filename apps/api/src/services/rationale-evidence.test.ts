import { describe, expect, test } from "vite-plus/test";
import {
	buildRationaleEvidenceQuery,
	mergeAutoCitedFactEvidence,
} from "./rationale-evidence";

describe("rationale evidence enrichment", () => {
	test("adds auto-cited facts without duplicating existing evidence", () => {
		const enriched = mergeAutoCitedFactEvidence(
			{ factIds: ["existing"] },
			[
				{ factId: "existing", score: 0.9 },
				{
					factId: "new-fact",
					score: 0.82,
					source: "doc://docs/cognition/brain.md",
				},
			],
			"brain flywheel",
			"2026-05-23T10:00:00.000Z",
		);

		expect(enriched.factIds).toEqual(["existing", "new-fact"]);
		expect(enriched.brain).toMatchObject({
			autoCitations: {
				source: "memory_vector",
				query: "brain flywheel",
				facts: [{ factId: "new-fact", score: 0.82 }],
			},
		});
	});

	test("builds compact rationale retrieval queries", () => {
		expect(
			buildRationaleEvidenceQuery({
				category: "architecture",
				action: "Persist flywheel snapshots",
				rationale:
					"Operators need proof that recent memory signals are improving.",
			}),
		).toContain("Persist flywheel snapshots");
	});
});
