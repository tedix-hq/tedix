import type { TraversalResult } from "../integrations/graph-db/types";
import { describe, expect, it } from "vite-plus/test";
import {
	benchmarkChecksum,
	buildAnchorOnlyObservation,
	buildProjectedGraphObservation,
	deterministicBenchmarkUuid,
	stableBenchmarkJson,
} from "./graph-retrieval-benchmark-harness";

function traversal(input: {
	facts: Array<[string, number]>;
	edges: Array<{
		sourceFactId: string;
		targetFactId: string;
		relationType: "related_to" | "requires";
	}>;
}): TraversalResult {
	return {
		facts: new Map(
			input.facts.map(([id, depth]) => [
				id,
				{
					depth,
					fact: {
						id,
						orgId: "org-1",
						tediId: null,
						domainId: null,
						content: id,
						summary: null,
						factType: "technical",
						confidence: 1,
						validTo: null,
						archivedAt: null,
						priority: null,
						visibility: "org",
						accessCount: 0,
						usageCount: 0,
						createdAt: null,
						updatedAt: null,
					},
				},
			]),
		),
		edges: input.edges.map((edge) => ({
			...edge,
			strength: 1,
			context: null,
		})),
	};
}

describe("graph retrieval benchmark harness", () => {
	it("canonicalizes object keys and produces stable server checksums", async () => {
		expect(stableBenchmarkJson({ z: 2, a: { y: 1, x: true } })).toBe(
			'{"a":{"x":true,"y":1},"z":2}',
		);
		expect(await benchmarkChecksum({ b: 2, a: 1 })).toBe(
			await benchmarkChecksum({ a: 1, b: 2 }),
		);
		expect(await deterministicBenchmarkUuid({ run: "r", case: "c" })).toBe(
			await deterministicBenchmarkUuid({ case: "c", run: "r" }),
		);
	});

	it("keeps the baseline fixed to anchors", () => {
		expect(buildAnchorOnlyObservation(["b", "a", "a"])).toEqual({
			retrievedFactIds: ["a", "b"],
			returnedEdges: [],
			returnedPaths: [],
		});
	});

	it("merges graph traversals and builds deterministic shortest paths", () => {
		const result = buildProjectedGraphObservation({
			anchorFactIds: ["a"],
			expectedFactIds: ["c"],
			maxDepth: 3,
			traversals: [
				traversal({
					facts: [
						["a", 0],
						["b", 1],
						["c", 2],
					],
					edges: [
						{
							sourceFactId: "b",
							targetFactId: "c",
							relationType: "requires",
						},
						{
							sourceFactId: "a",
							targetFactId: "b",
							relationType: "related_to",
						},
					],
				}),
			],
		});

		expect(result.retrievedFactIds).toEqual(["a", "b", "c"]);
		expect(result.returnedPaths).toEqual([
			{
				factIds: ["a", "b", "c"],
				edges: [
					{
						sourceFactId: "a",
						targetFactId: "b",
						relationType: "related_to",
					},
					{
						sourceFactId: "b",
						targetFactId: "c",
						relationType: "requires",
					},
				],
			},
		]);
	});

	it("never invents a path beyond the bounded depth", () => {
		const result = buildProjectedGraphObservation({
			anchorFactIds: ["a"],
			expectedFactIds: ["c"],
			maxDepth: 1,
			traversals: [
				traversal({
					facts: [
						["a", 0],
						["b", 1],
						["c", 2],
					],
					edges: [
						{
							sourceFactId: "a",
							targetFactId: "b",
							relationType: "related_to",
						},
						{
							sourceFactId: "b",
							targetFactId: "c",
							relationType: "requires",
						},
					],
				}),
			],
		});
		expect(result.returnedPaths).toEqual([]);
	});
});
