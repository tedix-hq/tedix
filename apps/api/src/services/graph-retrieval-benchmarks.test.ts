import { describe, expect, it } from "vite-plus/test";
import {
	type GraphRetrievalBenchmarkServiceError,
	requireEligiblePathGraphRetrievalBenchmarkCases,
	serverCaseChecksum,
	serverSuiteChecksum,
} from "./graph-retrieval-benchmarks";

describe("graph retrieval benchmark server definitions", () => {
	it("checksums the immutable case definition rather than caller metrics", async () => {
		const definition = {
			organizationId: "org-1",
			suiteId: "suite-1",
			caseId: "case-1",
			suiteRevision: 0,
			caseKey: "path-1",
			query: "What depends on the anchor?",
			anchorFactIds: ["fact-a"],
			expectedFactIds: ["fact-b"],
			expectedEdges: [
				{
					sourceFactId: "fact-a",
					targetFactId: "fact-b",
					relationType: "requires",
				},
			],
			expectedPaths: [],
			forbiddenFactIds: [],
			validAt: "2026-07-26T00:00:00.000Z",
			answerRubric: {},
			tags: ["gold"],
			difficulty: "intermediate",
		};
		expect(await serverCaseChecksum(definition)).toBe(
			await serverCaseChecksum({ ...definition }),
		);
	});

	it("keeps the suite checksum stable across lifecycle-only row changes", async () => {
		const definition = {
			id: "suite-1",
			organizationId: "org-1",
			name: "gold",
			version: 1,
			split: "locked_test",
			revision: 20,
			caseCount: 20,
			sourceCommit: "abc",
			artifactUri: null,
		};
		const cases = [{ id: "case-1", caseKey: "a", checksum: "checksum-1" }];
		const draft = await serverSuiteChecksum({
			suite: {
				...definition,
				status: "draft",
				definitionChecksum: null,
			},
			cases,
		});
		const locked = await serverSuiteChecksum({
			suite: {
				...definition,
				status: "locked",
				definitionChecksum: draft,
			},
			cases,
		});
		expect(locked).toBe(draft);
	});

	it("rejects an eligible start when any case lacks a nontrivial expected path", () => {
		expect(() =>
			requireEligiblePathGraphRetrievalBenchmarkCases(
				[
					{
						anchorFactIds: ["fact-a"],
						expectedPaths: [],
					},
				],
				1,
			),
		).toThrowError(
			expect.objectContaining<Partial<GraphRetrievalBenchmarkServiceError>>({
				reason: "invalid_case",
			}),
		);
		expect(() =>
			requireEligiblePathGraphRetrievalBenchmarkCases(
				[
					{
						anchorFactIds: ["fact-a"],
						expectedPaths: [{ factIds: ["fact-a"], edges: [] }],
					},
				],
				1,
			),
		).toThrow(/nontrivial expected path/);
	});
});
