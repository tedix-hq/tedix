import { describe, expect, it } from "vite-plus/test";
import { planExecutionClusters, type ReadyWorkCandidate } from "./scheduler";

function candidate(
	id: string,
	resourceClaims: ReadyWorkCandidate["resourceClaims"],
): ReadyWorkCandidate {
	return {
		workItem: { id } as ReadyWorkCandidate["workItem"],
		score: 0,
		factors: {
			priority: 0,
			urgency: 0,
			aging: 0,
			downstream: 0,
			criticalPath: 0,
			risk: 0,
			cost: 0,
			verifierBackpressure: 0,
		},
		readiness: { state: "ready", reasons: [] },
		graphTruncated: false,
		resourceClaims,
	};
}

const claim = (
	poolId: string,
	allocationMode: "exclusive" | "capacity",
	quantity: number,
	capacity: number,
) => ({
	poolId,
	resourceKey: poolId,
	allocationMode,
	quantity,
	capacity,
	reserved: 0,
});

describe("Work execution cluster planning", () => {
	it("keeps exclusive-resource work in separate waves", () => {
		const clusters = planExecutionClusters(
			[
				candidate("a", [claim("deploy", "exclusive", 1, 1)]),
				candidate("b", [claim("deploy", "exclusive", 1, 1)]),
			],
			8,
		);
		expect(
			clusters.map((cluster) => cluster.items.map((x) => x.workItem.id)),
		).toEqual([["a"], ["b"]]);
	});

	it("packs capacity-compatible work and respects the parallelism ceiling", () => {
		const clusters = planExecutionClusters(
			[
				candidate("a", [claim("browser", "capacity", 2, 5)]),
				candidate("b", [claim("browser", "capacity", 3, 5)]),
				candidate("c", []),
			],
			2,
		);
		expect(
			clusters.map((cluster) => cluster.items.map((x) => x.workItem.id)),
		).toEqual([["a", "b"], ["c"]]);
	});

	it("accounts for capacity already reserved outside the plan", () => {
		const constrained = claim("review", "capacity", 2, 5);
		constrained.reserved = 2;
		const clusters = planExecutionClusters(
			[candidate("a", [constrained]), candidate("b", [constrained])],
			8,
		);
		expect(clusters).toHaveLength(2);
	});
});
