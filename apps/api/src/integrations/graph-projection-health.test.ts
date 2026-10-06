import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const graphMocks = vi.hoisted(() => ({
	runCypherWithParams: vi.fn(),
}));

vi.mock("./graph-db/client", () => ({
	runCypherWithParams: graphMocks.runCypherWithParams,
}));

import {
	assessGraphProjectionCoverage,
	assessGraphProjectionEdgeParity,
	assessGraphProjectionLifecycleParity,
	assessGraphProjectionManagedCounts,
	readGraphProjectionManagedCounts,
} from "./graph-projection-health";

const checkedAt = "2026-07-18T12:00:00.000Z";

describe("assessGraphProjectionCoverage", () => {
	it("passes a current bounded D1 sample", () => {
		const result = assessGraphProjectionCoverage({
			canonicalFacts: [
				{ id: "fact-1", canonicalUpdatedAt: "2026-07-18T11:50:00.000Z" },
				{ id: "fact-2", canonicalUpdatedAt: "2026-07-18T11:40:00.000Z" },
			],
			projectedFacts: [
				{
					factId: "fact-1",
					projectedFactId: "fact-1",
					projectedUpdatedAt: "2026-07-18T11:50:00.000Z",
				},
				{
					factId: "fact-2",
					projectedFactId: "fact-2",
					projectedUpdatedAt: "2026-07-18T11:40:00.000Z",
				},
			],
			configured: true,
			transportHealthy: true,
			checkedAt,
			sampleLimit: 25,
		});

		expect(result).toMatchObject({
			authority: "d1",
			gateStatus: "passing",
			passesGate: true,
			sampleSize: 2,
			projectedCount: 2,
			missingCount: 0,
			overdueCount: 0,
			sampleCoverageRatio: 1,
			maxObservedLagMs: 0,
		});
	});

	it("fails overdue missing and stale facts", () => {
		const result = assessGraphProjectionCoverage({
			canonicalFacts: [
				{ id: "missing", canonicalUpdatedAt: "2026-07-18T11:00:00.000Z" },
				{ id: "stale", canonicalUpdatedAt: "2026-07-18T11:30:00.000Z" },
			],
			projectedFacts: [
				{
					factId: "missing",
					projectedFactId: null,
					projectedUpdatedAt: null,
				},
				{
					factId: "stale",
					projectedFactId: "stale",
					projectedUpdatedAt: "2026-07-18T11:00:00.000Z",
				},
			],
			configured: true,
			transportHealthy: true,
			checkedAt,
			sampleLimit: 25,
		});

		expect(result).toMatchObject({
			gateStatus: "failing",
			passesGate: false,
			projectedCount: 1,
			missingCount: 1,
			staleCount: 1,
			overdueCount: 2,
			sampleCoverageRatio: 0.5,
			maxObservedLagMs: 30 * 60 * 1000,
		});
		expect(result.facts.map((fact) => fact.status)).toEqual([
			"missing_overdue",
			"stale_overdue",
		]);
	});

	it("allows a recent asynchronous write only within coverage tolerance", () => {
		const canonicalFacts = Array.from({ length: 25 }, (_, index) => ({
			id: `fact-${index}`,
			canonicalUpdatedAt:
				index === 0 ? "2026-07-18T11:59:00.000Z" : "2026-07-18T11:00:00.000Z",
		}));
		const projectedFacts = canonicalFacts.map((fact, index) => ({
			factId: fact.id,
			projectedFactId: index === 0 ? null : fact.id,
			projectedUpdatedAt:
				index === 0
					? null
					: index === 1
						? "2026-07-18T10:59:00.000Z"
						: fact.canonicalUpdatedAt,
		}));

		const result = assessGraphProjectionCoverage({
			canonicalFacts,
			projectedFacts,
			configured: true,
			transportHealthy: true,
			checkedAt,
			sampleLimit: 25,
		});

		expect(result.gateStatus).toBe("passing");
		expect(result.sampleCoverageRatio).toBe(0.96);
		expect(result.overdueCount).toBe(0);
		expect(result.staleCount).toBe(0);
		expect(result.facts[0]?.status).toBe("within_lag_allowance");
		expect(result.facts[1]?.status).toBe("within_lag_allowance");
	});

	it("never passes when Neo4j transport is unavailable or D1 has no sample", () => {
		const unavailable = assessGraphProjectionCoverage({
			canonicalFacts: [
				{ id: "fact-1", canonicalUpdatedAt: "2026-07-18T11:00:00.000Z" },
			],
			projectedFacts: [],
			configured: true,
			transportHealthy: false,
			checkedAt,
			sampleLimit: 25,
		});
		const empty = assessGraphProjectionCoverage({
			canonicalFacts: [],
			projectedFacts: [],
			configured: true,
			transportHealthy: true,
			checkedAt,
			sampleLimit: 25,
		});

		expect(unavailable.gateStatus).toBe("unavailable");
		expect(unavailable.passesGate).toBe(false);
		expect(empty.gateStatus).toBe("insufficient_data");
		expect(empty.passesGate).toBe(false);
	});
});

describe("assessGraphProjectionEdgeParity", () => {
	it("fails closed for missing or mismatched D1 edges", () => {
		const result = assessGraphProjectionEdgeParity({
			canonicalEdges: [
				{
					id: "edge-current",
					sourceFactId: "a",
					targetFactId: "b",
					relationType: "requires",
					canonicalCreatedAt: checkedAt,
				},
				{
					id: "edge-mismatch",
					sourceFactId: "b",
					targetFactId: "c",
					relationType: "related_to",
					canonicalCreatedAt: checkedAt,
				},
				{
					id: "edge-missing",
					sourceFactId: "c",
					targetFactId: "d",
					relationType: "caused_by",
					canonicalCreatedAt: checkedAt,
				},
			],
			projectedEdges: [
				{
					edgeId: "edge-current",
					projectedEdgeId: "edge-current",
					projectedSourceFactId: "a",
					projectedTargetFactId: "b",
					projectedRelationType: "requires",
				},
				{
					edgeId: "edge-mismatch",
					projectedEdgeId: "edge-mismatch",
					projectedSourceFactId: "b",
					projectedTargetFactId: "c",
					projectedRelationType: "contradicts",
				},
			],
			transportHealthy: true,
		});

		expect(result).toMatchObject({
			passesGate: false,
			sampleSize: 3,
			projectedCount: 2,
			missingCount: 1,
			mismatchCount: 1,
		});
		expect(result.edges.map((edge) => edge.status)).toEqual([
			"current",
			"mismatched",
			"missing",
		]);
	});
});

describe("assessGraphProjectionLifecycleParity", () => {
	it("requires archived and invalidated lifecycle fields to match D1", () => {
		const result = assessGraphProjectionLifecycleParity({
			canonicalFacts: [
				{
					id: "archived",
					canonicalUpdatedAt: checkedAt,
					validTo: null,
					archivedAt: "2026-07-18T11:00:00.000Z",
				},
				{
					id: "invalidated",
					canonicalUpdatedAt: checkedAt,
					validTo: "2026-07-18T11:30:00.000Z",
					archivedAt: null,
				},
			],
			projectedFacts: [
				{
					factId: "archived",
					projectedFactId: "archived",
					projectedUpdatedAt: checkedAt,
					projectedValidTo: null,
					projectedArchivedAt: "2026-07-18T11:00:00.000Z",
				},
				{
					factId: "invalidated",
					projectedFactId: "invalidated",
					projectedUpdatedAt: checkedAt,
					projectedValidTo: null,
					projectedArchivedAt: null,
				},
			],
			transportHealthy: true,
		});

		expect(result).toMatchObject({
			passesGate: false,
			sampleSize: 2,
			projectedCount: 2,
			missingCount: 0,
			mismatchCount: 1,
		});
	});
});

describe("assessGraphProjectionManagedCounts", () => {
	it("requires exact D1-to-Neo4j parity for every managed kind", () => {
		const canonical = {
			facts: 2,
			edges: 1,
			domains: 1,
			tedis: 1,
			decisions: 1,
			decisionOutcomes: 1,
			decisionOwners: 1,
			decisionCompletions: 1,
			knowledgeEntries: 1,
			skills: 1,
			tediExpertise: 1,
			capabilities: 1,
			capabilityLinks: 1,
			entities: 1,
			entityResolutions: 1,
		};
		expect(
			assessGraphProjectionManagedCounts({
				canonical,
				projected: canonical,
				transportHealthy: true,
			}),
		).toMatchObject({ passesGate: true, mismatches: [] });

		const projected = { ...canonical, entityResolutions: 0 };
		expect(
			assessGraphProjectionManagedCounts({
				canonical,
				projected,
				transportHealthy: true,
			}),
		).toMatchObject({
			passesGate: false,
			mismatches: [
				{
					kind: "entityResolutions",
					canonicalCount: 1,
					projectedCount: 0,
					delta: -1,
				},
			],
		});
	});
});

describe("readGraphProjectionManagedCounts", () => {
	beforeEach(() => {
		graphMocks.runCypherWithParams.mockReset();
		graphMocks.runCypherWithParams.mockResolvedValue([{}]);
	});

	it("counts every canonical fact relation, including promoted_from", async () => {
		await readGraphProjectionManagedCounts({} as CloudflareEnv, "org-1");

		const [, query, parameters] = graphMocks.runCypherWithParams.mock.calls[0]!;
		expect(query).toContain("'PROMOTED_FROM'");
		expect(query).toContain("count(n) AS decisionOutcomes");
		expect(query).toContain("[r:DECIDED_BY]");
		expect(query).toContain("[r:COMPLETED_AS]");
		expect(parameters).toEqual({ orgId: "org-1" });
	});
});
