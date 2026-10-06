/**
 * memory-graph router composition.
 * Capability handlers and shared policy live in ./memory-graph/.
 */
import {
	assembleRoute,
	auditRoute,
	expertiseRoute,
	gapsRoute,
	graphRoute,
	healthRoute,
	listDomainsRoute,
	optimizeRoute,
	searchRoute,
	statsRoute,
} from "./memory-graph/graph-operations";
import { learn, reflect } from "./memory-graph/retrieval-learning";
import {
	feedback,
	link,
	opine,
	promote,
	reindex,
	review,
	synthesize,
} from "./memory-graph/review-reasoning";
import { memoryGraphOs } from "./memory-graph/policy-operations";

// =============================================================================
// ROUTER EXPORT
// =============================================================================

export const memoryGraphContractRouter = memoryGraphOs.router({
	search: searchRoute,
	audit: auditRoute,
	learn,
	reflect,
	listDomains: listDomainsRoute,
	expertise: expertiseRoute,
	promote,
	review,
	reindex,
	stats: statsRoute,
	assemble: assembleRoute,
	gaps: gapsRoute,
	health: healthRoute,
	link,
	synthesize,
	opine,
	feedback,
	graph: graphRoute,
	optimize: optimizeRoute,
});
