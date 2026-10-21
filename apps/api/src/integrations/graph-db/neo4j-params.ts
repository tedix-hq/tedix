import type {
	GraphCapabilityLink,
	GraphFact,
	GraphSyncEdge,
	GraphDecision,
} from "./types";

const FACT_RELATION_TYPES = new Set([
	"caused_by",
	"contradicts",
	"supersedes",
	"applies_to",
	"learned_from",
	"requires",
	"related_to",
	"promoted_from",
]);

export function factRelationshipType(relationType: string): string {
	if (!FACT_RELATION_TYPES.has(relationType)) {
		throw new Error(`Unknown fact relation type: ${relationType}`);
	}
	return relationType.toUpperCase();
}

export function graphFactParams(fact: GraphFact): Record<string, unknown> {
	return {
		id: fact.id,
		orgId: fact.orgId,
		tediId: fact.tediId,
		domainId: fact.domainId,
		content: fact.content,
		summary: fact.summary,
		factType: fact.factType,
		confidence: fact.confidence,
		validTo: fact.validTo,
		archivedAt: fact.archivedAt,
		priority: fact.priority,
		visibility: fact.visibility,
		accessCount: fact.accessCount,
		usageCount: fact.usageCount,
		createdAt: fact.createdAt,
		updatedAt: fact.updatedAt,
		projectionEpoch: fact.projectionEpoch ?? null,
		projectionRepairEpoch: fact.projectionRepairEpoch ?? null,
	};
}

export function graphEdgeParams(edge: GraphSyncEdge): Record<string, unknown> {
	return {
		id: edge.id,
		orgId: edge.orgId,
		sourceFactId: edge.sourceFactId,
		targetFactId: edge.targetFactId,
		relationType: edge.relationType,
		strength: edge.strength,
		context: edge.context,
		updatedAt: edge.updatedAt,
		projectionEpoch: edge.projectionEpoch ?? null,
		projectionRepairEpoch: edge.projectionRepairEpoch ?? null,
	};
}

/**
 * Node label per capability-link entity kind. Enum-checked before Cypher
 * interpolation — never interpolate a raw caller string as a label.
 */
const CAPABILITY_LINK_LABELS: Record<
	GraphCapabilityLink["entityKind"],
	string
> = {
	skill: "Skill",
	app: "App",
	tedi: "Tedi",
	external_agent: "ExternalAgent",
	objective: "Objective",
};

export type ProjectionNodeLabel =
	| "Fact"
	| "Domain"
	| "Tedi"
	| "ExternalAgent"
	| "Decision"
	| "Outcome"
	| "KnowledgeEntry"
	| "Skill"
	| "Capability"
	| "App"
	| "Objective"
	| "ApprovalRequest"
	| "Entity"
	| "EntityResolution"
	| "EntityResolutionDecision"
	| "Project"
	| "WorkItem"
	| "WorkItemSource";

export function capabilityLinkLabel(
	entityKind: GraphCapabilityLink["entityKind"],
): ProjectionNodeLabel {
	const label = CAPABILITY_LINK_LABELS[entityKind];
	if (!label) {
		throw new Error(`Unknown capability link entity kind: ${entityKind}`);
	}
	return label as ProjectionNodeLabel;
}

export function decisionBatchParams(decision: GraphDecision) {
	const { evidence, ...context } = decision;
	return {
		...context,
		objectiveId: decision.objectiveId ?? null,
		approvalRequestId: decision.approvalRequestId ?? null,
		completedAt: decision.completedAt ?? null,
		outcomeId: `${decision.id}:outcome`,
		evidenceFactIds: parseEvidenceFactIds(evidence),
		projectionEpoch: decision.projectionEpoch ?? null,
		projectionRepairEpoch: decision.projectionRepairEpoch ?? null,
	};
}
export function toNumber(value: unknown): number {
	if (value === null || value === undefined) return 0;
	if (typeof value === "number") return value;
	return Number(value) || 0;
}

/**
 * Parse evidence JSON string to extract fact IDs.
 * Evidence format varies — could be JSON object or stringified array.
 */
export function parseEvidenceFactIds(evidence: string): string[] {
	try {
		const parsed = JSON.parse(evidence);
		if (Array.isArray(parsed))
			return parsed.filter((x) => typeof x === "string");
		if (typeof parsed === "object" && parsed !== null) {
			if (Array.isArray(parsed.factIds)) return parsed.factIds;
			if (Array.isArray(parsed.facts))
				return parsed.facts.map((f: { id?: string }) => f.id).filter(Boolean);
			if (Array.isArray(parsed.retrievedFacts)) {
				return parsed.retrievedFacts
					.map((f: { id?: string; factId?: string }) => f.id ?? f.factId)
					.filter(Boolean);
			}
		}
		return [];
	} catch {
		return [];
	}
}

export type AdoptUnownedLegacyNodes = (
	nodes: Array<{
		label: ProjectionNodeLabel;
		id: string | null | undefined;
		orgId: string;
	}>,
) => Promise<void>;
