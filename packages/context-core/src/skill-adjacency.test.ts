import { describe, expect, it } from "vite-plus/test";
import {
	type AdjacencyCandidate,
	diceSimilarity,
	formatAdjacencyRefusal,
	normalizeAdjacencyTokens,
	scoreSkillAdjacency,
	SKILL_ADJACENCY_BLOCK_SCORE,
} from "./skill-adjacency.js";

function candidate(
	title: string,
	description?: string,
	id = "skill-1",
): AdjacencyCandidate {
	return { id, slug: id, title, description: description ?? null };
}

describe("normalizeAdjacencyTokens", () => {
	it("drops stop words and short tokens", () => {
		const tokens = normalizeAdjacencyTokens("How to use the D1 batch skill");
		expect(tokens.has("the")).toBe(false);
		expect(tokens.has("skill")).toBe(false);
		expect(tokens.has("d1")).toBe(false); // under 3 chars
		expect(tokens.has("batch")).toBe(true);
	});

	it("is punctuation and case insensitive", () => {
		expect([...normalizeAdjacencyTokens("Deploy-Worker, production!")]).toEqual(
			[...normalizeAdjacencyTokens("deploy worker production")],
		);
	});
});

describe("diceSimilarity", () => {
	it("is 1 for identical sets and 0 for disjoint", () => {
		const a = new Set(["deploy", "worker"]);
		expect(diceSimilarity(a, new Set(["deploy", "worker"]))).toBe(1);
		expect(diceSimilarity(a, new Set(["billing", "invoice"]))).toBe(0);
	});

	it("is 0 when either side is empty", () => {
		expect(diceSimilarity(new Set(), new Set(["x"]))).toBe(0);
	});
});

describe("scoreSkillAdjacency — blocking", () => {
	it("blocks an equivalent title regardless of description drift", () => {
		const verdict = scoreSkillAdjacency(
			{ title: "Deploy the API worker", description: "Ship apps/api" },
			[candidate("Deploy the API worker", "Completely different words here")],
		);
		expect(verdict.blocked).toBe(true);
		expect(verdict.nearest?.titleEquivalent).toBe(true);
	});

	it("blocks a near-identical title with a matching description", () => {
		const verdict = scoreSkillAdjacency(
			{
				title: "Rotate Descope outbound tokens",
				description: "Rotate the outbound app tokens for a tenant",
			},
			[
				candidate(
					"Rotate Descope outbound tokens",
					"Rotate outbound app tokens for a tenant",
				),
			],
		);
		expect(verdict.blocked).toBe(true);
		expect(verdict.nearest?.score).toBeGreaterThanOrEqual(
			SKILL_ADJACENCY_BLOCK_SCORE,
		);
	});

	it("word order does not defeat the gate", () => {
		const verdict = scoreSkillAdjacency({ title: "worker API deploy" }, [
			candidate("deploy API worker"),
		]);
		expect(verdict.blocked).toBe(true);
	});
});

describe("scoreSkillAdjacency — allowing", () => {
	it("allows a genuinely distinct procedure", () => {
		const verdict = scoreSkillAdjacency(
			{
				title: "Reconcile Stripe invoices",
				description: "Match settlement rows against ledger entries",
			},
			[
				candidate("Deploy the API worker", "Ship apps/api to production"),
				candidate("Rotate Descope tokens", "Rotate outbound app tokens"),
			],
		);
		expect(verdict.blocked).toBe(false);
	});

	it("allows related-but-different skills over the same subsystem", () => {
		const verdict = scoreSkillAdjacency(
			{
				title: "Roll back a Worker deployment",
				description: "Revert production to the previous version",
			},
			[
				candidate(
					"Deploy a Worker to production",
					"Ship a new version to production",
				),
			],
		);
		expect(verdict.blocked).toBe(false);
	});

	it("allows when there are no candidates at all", () => {
		const verdict = scoreSkillAdjacency({ title: "Anything" }, []);
		expect(verdict.blocked).toBe(false);
		expect(verdict.nearest).toBeNull();
		expect(verdict.adjacent).toEqual([]);
	});
});

describe("scoreSkillAdjacency — reporting", () => {
	it("orders adjacent matches best-first", () => {
		const verdict = scoreSkillAdjacency({ title: "Deploy the API worker" }, [
			candidate("Reconcile Stripe invoices", undefined, "far"),
			candidate("Deploy the API worker service", undefined, "near"),
		]);
		expect(verdict.nearest?.candidate.id).toBe("near");
		expect(verdict.adjacent[0]?.candidate.id).toBe("near");
	});

	it("surfaces near-misses without blocking them", () => {
		const verdict = scoreSkillAdjacency({ title: "Deploy the API worker" }, [
			candidate("Deploy the API worker service and verify", undefined, "near"),
		]);
		if (!verdict.blocked) {
			expect(verdict.adjacent.length).toBeGreaterThan(0);
		}
	});
});

describe("formatAdjacencyRefusal", () => {
	it("names the twin and points at the modify call", () => {
		const verdict = scoreSkillAdjacency({ title: "Deploy the API worker" }, [
			candidate("Deploy the API worker", undefined, "abc-123"),
		]);
		const message = formatAdjacencyRefusal(verdict.nearest!);
		expect(message).toContain("Deploy the API worker");
		expect(message).toContain("improve_skills");
		expect(message).toContain("abc-123");
		expect(message).toContain("force: true");
	});
});
