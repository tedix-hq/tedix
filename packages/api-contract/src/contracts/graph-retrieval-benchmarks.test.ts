import { describe, expect, it } from "vite-plus/test";
import { procedureInputSchema } from "../utils/procedure-schemas";
import {
	GraphRetrievalBenchmarkResultSchema,
	graphRetrievalBenchmarksContract,
} from "./graph-retrieval-benchmarks";

// Reads the schema through the shared facade rather than a hand-rolled
// `{ "~orpc": { inputSchema: { shape } } }` cast. That cast satisfied the
// compiler while silently breaking at runtime under oRPC v2, where the key
// became `inputSchemas` (an array, since `.input()` now stacks).
function inputKeys(procedure: unknown): string[] {
	const schema = procedureInputSchema(procedure) as
		| { shape?: Record<string, unknown> }
		| undefined;
	if (!schema?.shape) {
		throw new Error("procedure has no object input schema");
	}
	return Object.keys(schema.shape).sort();
}

describe("graph retrieval benchmark contract", () => {
	it("keeps harness identity, seed, depth, and fanout server-owned", () => {
		expect(inputKeys(graphRetrievalBenchmarksContract.startPair)).toEqual([
			"baselineRunId",
			"graphRunId",
			"organizationId",
			"pairedRunKey",
			"suiteId",
		]);
		expect(inputKeys(graphRetrievalBenchmarksContract.executePair)).toEqual([
			"baselineRunId",
			"graphRunId",
			"organizationId",
			"pairedRunKey",
		]);
	});

	it("exposes immutable result provenance", () => {
		expect(Object.keys(GraphRetrievalBenchmarkResultSchema.shape)).toContain(
			"origin",
		);
		expect(
			GraphRetrievalBenchmarkResultSchema.shape.origin.safeParse("manual")
				.success,
		).toBe(true);
		expect(
			GraphRetrievalBenchmarkResultSchema.shape.origin.safeParse("builtin")
				.success,
		).toBe(true);
	});
});
