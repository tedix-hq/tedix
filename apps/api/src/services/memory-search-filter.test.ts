import type { MemoryFact } from "@tedix/db/schema/memory-graph";
import { describe, expect, it } from "vite-plus/test";
import { isMemorySearchFactEligible } from "./memory-search-filter";

const baseFact: MemoryFact = {
	id: "fact-1",
	organizationId: "org-1",
	tediId: "tedi-1",
	domainId: "domain-1",
	content: "A useful fact",
	summary: null,
	factType: "technical",
	confidence: 0.8,
	validFrom: "2026-06-16T00:00:00.000Z",
	validTo: null,
	status: "active",
	source: "doc://docs/cognition/brain.md",
	sourceSessionId: null,
	sourceUrl: null,
	sourceHash: "hash",
	embeddingId: "memory:fact-1",
	topicKey: null,
	memoryScope: "tedi",
	usePolicy: "can_use_as_evidence",
	reviewStatus: "pending",
	priority: "active",
	visibility: "private",
	promotedFrom: null,
	promotedAt: null,
	metadata: null,
	lastVerifiedAt: null,
	lastAccessedAt: null,
	accessCount: 0,
	usageCount: 0,
	archivedAt: null,
	createdAt: "2026-06-16T00:00:00.000Z",
	updatedAt: "2026-06-16T00:00:00.000Z",
};

function fact(overrides: Partial<MemoryFact> = {}): MemoryFact {
	return { ...baseFact, ...overrides };
}

describe("isMemorySearchFactEligible", () => {
	it("allows active org-visible facts for the requested organization", () => {
		expect(
			isMemorySearchFactEligible(fact({ visibility: "org" }), {
				orgId: "org-1",
				tediId: "tedi-2",
			}),
		).toBe(true);
	});

	it("allows a tedi to see its own private fact", () => {
		expect(
			isMemorySearchFactEligible(fact(), {
				orgId: "org-1",
				tediId: "tedi-1",
			}),
		).toBe(true);
	});

	it("excludes every tedi's private facts when no tediId is provided", () => {
		const options = { orgId: "org-1" };
		expect(
			isMemorySearchFactEligible(fact({ tediId: "tedi-1" }), options),
		).toBe(false);
		expect(
			isMemorySearchFactEligible(fact({ tediId: "tedi-2" }), options),
		).toBe(false);
	});

	it("still returns org and shared facts when no tediId is provided", () => {
		const options = { orgId: "org-1" };
		expect(
			isMemorySearchFactEligible(fact({ visibility: "org" }), options),
		).toBe(true);
		expect(
			isMemorySearchFactEligible(fact({ visibility: "shared" }), options),
		).toBe(true);
	});

	it("rejects another tedi's private fact when a tediId is provided", () => {
		expect(
			isMemorySearchFactEligible(fact({ tediId: "tedi-2" }), {
				orgId: "org-1",
				tediId: "tedi-1",
			}),
		).toBe(false);
	});

	it("rejects stale vector hits after D1 hydration", () => {
		const options = { orgId: "org-1", tediId: "tedi-1" };
		expect(
			isMemorySearchFactEligible(fact({ archivedAt: "2026-06-16" }), options),
		).toBe(false);
		expect(
			isMemorySearchFactEligible(fact({ validTo: "2026-06-16" }), options),
		).toBe(false);
	});

	it("rejects candidates blocked by canonical review governance", () => {
		const options = { orgId: "org-1", tediId: "tedi-1" };
		for (const reviewStatus of [
			"restricted",
			"rejected",
			"superseded",
			"stale",
			"disputed",
		] as const) {
			expect(isMemorySearchFactEligible(fact({ reviewStatus }), options)).toBe(
				false,
			);
		}
	});

	it("excludes graph anchors from ordinary recall unless explicitly requested", () => {
		const graphAnchor = fact({
			memoryScope: "graph",
			usePolicy: "do_not_inject_automatically",
		});
		expect(
			isMemorySearchFactEligible(graphAnchor, {
				orgId: "org-1",
				tediId: "tedi-1",
			}),
		).toBe(false);
		expect(
			isMemorySearchFactEligible(graphAnchor, {
				orgId: "org-1",
				tediId: "tedi-1",
				includeGraphAnchors: true,
			}),
		).toBe(true);
	});

	it("rechecks D1 org, visibility, domain, type, and confidence filters", () => {
		const options = {
			orgId: "org-1",
			tediId: "tedi-1",
			domainId: "domain-1",
			factType: "technical" as const,
			minConfidence: 0.7,
		};

		expect(
			isMemorySearchFactEligible(fact({ organizationId: "org-2" }), options),
		).toBe(false);
		expect(
			isMemorySearchFactEligible(fact({ tediId: "tedi-2" }), options),
		).toBe(false);
		expect(
			isMemorySearchFactEligible(fact({ domainId: "domain-2" }), options),
		).toBe(false);
		expect(
			isMemorySearchFactEligible(fact({ factType: "decision" }), options),
		).toBe(false);
		expect(isMemorySearchFactEligible(fact({ confidence: 0.5 }), options)).toBe(
			false,
		);
	});
});
