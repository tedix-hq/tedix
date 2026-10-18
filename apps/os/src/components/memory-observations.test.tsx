import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { Fact } from "@tedix/api-contract/schemas/memory-graph";
import { ObservationEvidence } from "./memory-observations";

describe("observation evidence in Brain", () => {
	it("shows both sides of a dispute and a readable version/refresh trace", () => {
		const fact = {
			id: "orchard-observation",
			content:
				"Conflicting evidence: Orchard uses Monday builds. Orchard uses Tuesday builds.",
			confidence: 0.8,
			metadata: {
				consolidation: {
					version: 1,
					kind: "observation",
					entityKey: "orchard:repo",
					topicKey: "orchard:repo",
					revision: 2,
					fingerprint: "fixture",
					sourceHashes: {},
					scope: { tediId: null, visibility: "org", memoryScope: "org" },
					state: "disputed",
					evidence: {
						version: 1,
						state: "held",
						supportCount: 2,
						sources: [
							{ kind: "fact", id: "orchard-a", quote: "Monday builds" },
							{ kind: "fact", id: "orchard-b", quote: "Tuesday builds" },
						],
					},
					observationIds: [],
					firstSeen: "2026-09-01T00:00:00Z",
					lastSeen: "2026-09-02T00:00:00Z",
					previousVersionId: "orchard:v1",
					isHistory: false,
					refresh: {
						at: "2026-09-03T00:00:00Z",
						reason: "contradiction",
						sourceFactIds: ["orchard-b"],
						removedSourceFactIds: [],
						previousText: "Orchard uses Monday builds.",
					},
				},
			},
		} as unknown as Fact;
		const html = renderToStaticMarkup(<ObservationEvidence fact={fact} />);
		for (const text of [
			"disputed",
			"Version 2",
			"2 sources",
			"Monday builds",
			"Tuesday builds",
			"Previous text:",
			"contradiction",
			"orchard:v1",
			"orchard-b",
		])
			expect(html).toContain(text);
	});
});
