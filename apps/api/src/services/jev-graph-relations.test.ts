import { describe, it, expect } from "vite-plus/test";
import {
	graphRelationRequest,
	resolveGraphRelation,
	type GraphRelationPair,
} from "./jev-graph-relations";
import type { JevResult } from "@tedix/workers-ai/jev";
const pair: GraphRelationPair = {
	a: {
		id: "a",
		organizationId: "org",
		domainId: "domain",
		content: "From2026-09-01 order retention is60days.",
	},
	b: {
		id: "b",
		organizationId: "org",
		domainId: "domain",
		content: "Before2026-09-01 order retention was30days.",
	},
};
const response = (choice: string, support = 0.99) =>
	({
		model: "jev-1.13.0",
		usage: { input_tokens: 20, output_tokens: 10 },
		answers: {
			relation: { type: "choice", choice, confidence: 0, probabilities: {} },
			sourceSupport: { type: "noul", noul: support },
		},
	}) as JevResult<
		NonNullable<ReturnType<typeof graphRelationRequest>>["questions"]
	>;
describe("bounded graph relation recipe", () => {
	it("preserves explicit temporal direction without confidence gate", () => {
		expect(resolveGraphRelation(response("supersedes_b_a"), pair, 0.9)).toEqual(
			{ sourceFactId: "b", targetFactId: "a", relationType: "supersedes" },
		);
	});
	it("abstains below calibrated source support", () =>
		expect(
			resolveGraphRelation(response("contradicts", 0.4), pair, 0.9),
		).toBeNull());
	it.each(["NONE", "invented"])("rejects %s", (choice) =>
		expect(resolveGraphRelation(response(choice), pair, 0.9)).toBeNull(),
	);
	it("does not cross tenant or domain boundaries", () => {
		expect(
			graphRelationRequest({
				...pair,
				b: { ...pair.b, organizationId: "other" },
			}),
		).toBeNull();
		expect(
			graphRelationRequest({ ...pair, b: { ...pair.b, domainId: "other" } }),
		).toBeNull();
	});
	it("rejects empty, duplicate and oversized facts without truncation", () => {
		expect(
			graphRelationRequest({ ...pair, b: { ...pair.b, id: "a" } }),
		).toBeNull();
		expect(
			graphRelationRequest({ ...pair, b: { ...pair.b, content: "" } }),
		).toBeNull();
		expect(
			graphRelationRequest({
				...pair,
				b: { ...pair.b, content: "あ".repeat(8000) },
			}),
		).toBeNull();
	});
});
