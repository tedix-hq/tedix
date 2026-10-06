import type { FactType } from "@tedix/db/queries/memory-graph/facts";
import type { MemoryFact } from "@tedix/db/schema/memory-graph";
import { isCanonicalMemoryReviewAllowed } from "../integrations/cloudflare/agent-memory";

export type MemorySearchFactEligibility = {
	orgId: string;
	tediId?: string;
	domainId?: string;
	factType?: FactType;
	minConfidence?: number;
	includeGraphAnchors?: boolean;
};

export function isMemorySearchFactEligible(
	fact: MemoryFact,
	options: MemorySearchFactEligibility,
): boolean {
	if (fact.organizationId !== options.orgId) return false;
	if (fact.archivedAt || fact.validTo) return false;
	if (!isCanonicalMemoryReviewAllowed(fact.reviewStatus)) return false;
	if (options.domainId && fact.domainId !== options.domainId) return false;
	if (options.factType && fact.factType !== options.factType) return false;
	if (
		!options.includeGraphAnchors &&
		(fact.memoryScope === "graph" ||
			fact.usePolicy === "do_not_inject_automatically")
	) {
		return false;
	}
	if (
		options.minConfidence !== undefined &&
		fact.confidence < options.minConfidence
	) {
		return false;
	}

	// Visibility: org- and shared-visible facts are readable by any in-org
	// caller. A private fact is readable ONLY by its owning tedi — a request
	// without a tediId gets the least-privileged read (org + shared), never
	// every tedi's private facts.
	if (fact.visibility === "org" || fact.visibility === "shared") return true;
	if (!options.tediId) return false;
	return fact.visibility === "private" && fact.tediId === options.tediId;
}
