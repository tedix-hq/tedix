/**
 * Graph DB Types
 *
 * Types for the Neo4j context-graph projection.
 * D1 remains canonical; these shapes describe the read-optimized graph view
 * used by decision provenance, traversal, influence, and visualization.
 */

// ============================================================================
// Node Types (mirrors D1 schema, subset of fields relevant to graph ops)
// ============================================================================

/**
 * Projection generation and repair marks carried by hydrated outbox events.
 *
 * `projectionEpoch` is the stable graph generation used by the production
 * mark/sweep. `projectionRepairEpoch` is the short-lived full-repair mark.
 * Writers preserve an existing mark when either optional value is omitted.
 */
export interface GraphProjectionStamped {
	projectionEpoch?: string;
	projectionRepairEpoch?: string;
}

export interface GraphFact extends GraphProjectionStamped {
	id: string;
	orgId: string;
	tediId: string | null;
	domainId: string | null;
	content: string;
	summary: string | null;
	factType: string;
	confidence: number;
	validTo: string | null;
	archivedAt: string | null;
	priority: string | null;
	visibility: string | null;
	accessCount: number;
	usageCount: number;
	createdAt: string | null;
	updatedAt: string | null;
}

export interface GraphDomain extends GraphProjectionStamped {
	id: string;
	orgId: string;
	name: string;
	parentId: string | null;
	description: string | null;
}

export interface GraphTedi extends GraphProjectionStamped {
	id: string;
	orgId: string;
	slug: string;
	name: string;
}

export interface GraphDecision extends GraphProjectionStamped {
	id: string;
	tediId: string;
	orgId: string;
	action: string;
	rationale: string;
	category: string;
	confidence: number;
	outcomeStatus: string;
	evidence: string;
	objectiveId?: string | null;
	approvalRequestId?: string | null;
	createdAt: string;
	completedAt: string | null;
}

export interface GraphKnowledgeEntry extends GraphProjectionStamped {
	id: string;
	orgId: string;
	tediId: string | null;
	domainId: string | null;
	title: string;
	content: string;
	entryType: string;
	confidence: number;
	visibility: string;
	revision?: number;
	sourceFactIds?: string[] | null;
	createdAt: string;
	updatedAt: string;
}

export interface GraphTediExpertise extends GraphProjectionStamped {
	/** May be omitted when the canonical SyncEvent envelope supplies tenant scope. */
	orgId?: string;
	tediId: string;
	domainId: string;
	level: string;
	avgConfidence: number;
}

export interface GraphSkill extends GraphProjectionStamped {
	id: string;
	orgId: string;
	tediId: string | null;
	domainId: string | null;
	title: string;
	content: string;
	visibility: string;
	slug?: string | null;
	successCount?: number;
	failureCount?: number;
	revision: number;
	createdAt: string;
	updatedAt: string;
}

/**
 * Business capability node (org_capabilities projection — flywheel P5 #2).
 * D1 stays canonical; archive is projected as status, not deletion.
 */
export interface GraphCapability extends GraphProjectionStamped {
	id: string;
	orgId: string;
	parentId: string | null;
	name: string;
	slug: string;
	valueStream: string | null;
	paceLayer: string;
	maturityScore: number | null;
	status: string;
}

/**
 * Project node (`projects` projection). The top of the work hierarchy and the
 * anchor a client engagement is asked about ("how is ACME going").
 */
export interface GraphProject extends GraphProjectionStamped {
	id: string;
	orgId: string;
	key: string;
	name: string;
	status: string;
	leadTediId: string | null;
	objectiveId: string | null;
}

/**
 * Work Item node (`work_items` projection). Materialized with
 * `(:WorkItem)-[:IN_PROJECT]->(:Project)` so the work graph becomes traversable
 * beside the cognitive one — the join that previously existed only in D1.
 *
 * Deliberately NOT the full row: title/disposition/work kind/priority are what
 * a traversal filters on. Description, metadata, and attempt runtime stay in D1, which remains
 * canonical.
 */
export interface GraphWorkItem extends GraphProjectionStamped {
	id: string;
	orgId: string;
	title: string;
	workKind: string;
	disposition: string;
	priority: string;
	projectId: string | null;
	parentWorkItemId: string | null;
	assigneeTediId: string | null;
	objectiveId: string | null;
}

/**
 * External source attached to work (`work_item_sources` projection). Identity
 * only — provider, external id, url, title, freshness state — never source
 * content.
 */
export interface GraphWorkItemSource extends GraphProjectionStamped {
	id: string;
	orgId: string;
	provider: string;
	externalId: string;
	kind: string;
	state: string;
	title: string | null;
	externalUrl: string | null;
	projectId: string | null;
	workItemId: string | null;
}

/**
 * Capability↔entity link (capability_links projection). Materialized as
 * `(entity)-[:SUPPORTS]->(:Capability)` with the entity label derived from
 * entityKind (Skill/App/Tedi/Objective).
 */
export interface GraphCapabilityLink extends GraphProjectionStamped {
	capabilityId: string;
	orgId: string;
	entityKind: "skill" | "app" | "tedi" | "external_agent" | "objective";
	entityId: string;
}

/**
 * Canonical entity identity projected from D1. Entity merging is represented
 * as lifecycle state; Neo4j never decides or performs an irreversible merge.
 */
export interface GraphEntity extends GraphProjectionStamped {
	id: string;
	orgId: string;
	entityType: string;
	displayName: string;
	normalizedName: string;
	status: string;
	mergedIntoEntityId: string | null;
	version: number;
	updatedAt: string;
}

/**
 * One governed mention -> entity resolution decision. Revocation preserves the
 * node and closes validity instead of erasing the adjudication trail.
 */
export interface GraphEntityResolution extends GraphProjectionStamped {
	id: string;
	orgId: string;
	mentionId: string;
	factId: string | null;
	entityId: string;
	decisionId: string | null;
	confidence: number;
	validFrom: string;
	validTo: string | null;
	status: string;
}

/** Minimal tombstone required to preserve the canonical D1 validity cutoff. */
export interface GraphEntityResolutionRevocation {
	validTo: string;
}

// ============================================================================
// Edge / Relationship Types
// ============================================================================

export type FactRelationType =
	| "caused_by"
	| "contradicts"
	| "supersedes"
	| "applies_to"
	| "learned_from"
	| "requires"
	| "related_to"
	| "promoted_from";

export interface GraphEdge {
	/** Required for writes; older read-only call sites may omit while migrating. */
	orgId?: string;
	sourceFactId: string;
	targetFactId: string;
	relationType: FactRelationType;
	strength: number;
	context: string | null;
}

/**
 * Projection writes require explicit tenant scope and canonical edge identity.
 * Read-side `GraphEdge` stays transport-neutral; only writes use this shape.
 */
export interface GraphSyncEdge extends GraphEdge, GraphProjectionStamped {
	id: string;
	orgId: string;
	updatedAt: string | null;
}

// ============================================================================
// Query Result Types
// ============================================================================

export interface SimilarFact {
	factId: string;
	score: number;
	source: "structural" | "semantic" | "hybrid";
}

export interface SimilarDecision {
	decisionId: string;
	action: string;
	rationale: string;
	outcomeStatus: string;
	confidence: number;
	score: number;
}

export interface GraphPath {
	factIds: string[];
	relationTypes: string[];
	hops: number;
}

export interface CausalChain {
	decisionId: string;
	nodes: Array<{
		id: string;
		type: "decision" | "fact";
		label: string;
		depth: number;
	}>;
	edges: Array<{
		source: string;
		target: string;
		relationType: string;
	}>;
}

export interface Community {
	communityId: number;
	factIds: string[];
	size: number;
	dominantDomain: string | null;
}

export interface InfluenceScore {
	factId: string;
	pageRank: number;
	summary: string | null;
	factType: string;
}

export interface TraversalResult {
	facts: Map<string, { fact: GraphFact; depth: number }>;
	edges: GraphEdge[];
}

// ============================================================================
// Visualization Types (for Tedix OS dashboard)
// ============================================================================

export interface GraphVisualizationNode {
	id: string;
	label: string;
	type:
		| "fact"
		| "decision"
		| "domain"
		| "tedi"
		| "skill"
		| "knowledge_entry"
		| "outcome"
		| "objective"
		| "approval_request";
	properties: Record<string, unknown>;
}

export interface GraphVisualizationEdge {
	source: string;
	target: string;
	type: string;
	properties: Record<string, unknown>;
}

export interface GraphVisualizationData {
	nodes: GraphVisualizationNode[];
	edges: GraphVisualizationEdge[];
}

export interface VisualizationParams {
	orgId: string;
	tediId?: string;
	domainId?: string;
	centerFactId?: string;
	depth?: number;
	maxNodes?: number;
}

// ============================================================================
// Sync Types
// ============================================================================

export type SyncOperation =
	| "upsert_fact"
	| "upsert_edge"
	| "upsert_domain"
	| "upsert_tedi"
	| "upsert_decision"
	| "upsert_knowledge_entry"
	| "upsert_skill"
	| "upsert_tedi_expertise"
	| "upsert_capability"
	| "upsert_capability_link"
	| "upsert_entity"
	| "upsert_entity_resolution"
	| "upsert_project"
	| "upsert_work_item"
	| "upsert_work_item_source"
	| "delete_fact"
	| "delete_edge"
	| "delete_domain"
	| "delete_tedi"
	| "delete_decision"
	| "delete_knowledge_entry"
	| "delete_skill"
	| "delete_tedi_expertise"
	| "delete_capability"
	| "delete_capability_link"
	| "delete_entity"
	| "delete_project"
	| "delete_work_item"
	| "delete_work_item_source"
	| "revoke_entity_resolution";

export interface SyncEvent {
	op: SyncOperation;
	id: string;
	orgId: string;
	timestamp: number;
	/** Full entity payload for upserts (avoids re-fetching from D1) */
	payload?:
		| GraphFact
		// Legacy callers may omit edge write metadata from the payload because
		// the event envelope already carries id/orgId. The consumer normalizes
		// this to GraphSyncEdge before invoking a writer.
		| GraphEdge
		| GraphSyncEdge
		| GraphDomain
		| GraphTedi
		| GraphDecision
		| GraphKnowledgeEntry
		| GraphSkill
		| GraphTediExpertise
		| GraphCapability
		| GraphCapabilityLink
		| GraphEntity
		| GraphEntityResolution
		| GraphEntityResolutionRevocation
		| GraphProject
		| GraphWorkItem
		| GraphWorkItemSource;
}

// ============================================================================
// Client Configuration
// ============================================================================

export interface GraphDbConfig {
	/** Connection URI (e.g. neo4j+s://xxx.databases.neo4j.io) */
	uri: string;
	/** Auth username */
	user: string;
	/** Auth password */
	password: string;
	/** Database name (default: neo4j) */
	database?: string;
}
