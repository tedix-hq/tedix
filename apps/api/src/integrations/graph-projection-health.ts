/// <reference path="../../worker-configuration.d.ts" />

import type {
	GraphProjectionCanonicalEdge,
	GraphProjectionCanonicalFact,
	GraphProjectionCanonicalLifecycleFact,
	GraphProjectionManagedCounts,
} from "@tedix/db/queries/graph-projection-health";
import { runCypherWithParams } from "./graph-db/client";

export const GRAPH_PROJECTION_MIN_SAMPLE_COVERAGE_RATIO = 0.95;
export const GRAPH_PROJECTION_MAX_LAG_MS = 5 * 60 * 1000;

export type GraphProjectionRow = {
	factId: string;
	projectedFactId: string | null;
	projectedUpdatedAt: string | null;
	projectedValidTo?: string | null;
	projectedArchivedAt?: string | null;
};

export type GraphProjectionEdgeRow = {
	edgeId: string;
	projectedEdgeId: string | null;
	projectedSourceFactId: string | null;
	projectedTargetFactId: string | null;
	projectedRelationType: string | null;
};

export type GraphProjectionFactDiagnostic = {
	factId: string;
	canonicalUpdatedAt: string | null;
	projectedUpdatedAt: string | null;
	lagMs: number | null;
	status:
		| "current"
		| "within_lag_allowance"
		| "missing_overdue"
		| "stale_overdue";
};

export type GraphProjectionCoverageDiagnostic = {
	authority: "d1";
	gateStatus: "passing" | "failing" | "unavailable" | "insufficient_data";
	passesGate: boolean;
	checkedAt: string;
	sampleLimit: number;
	sampleSize: number;
	projectedCount: number;
	missingCount: number;
	staleCount: number;
	overdueCount: number;
	sampleCoverageRatio: number | null;
	newestCanonicalAt: string | null;
	newestProjectedAt: string | null;
	maxObservedLagMs: number | null;
	thresholds: {
		minSampleCoverageRatio: number;
		maxProjectionLagMs: number;
	};
	facts: GraphProjectionFactDiagnostic[];
};

export type GraphProjectionEdgeDiagnostic = {
	authority: "d1";
	passesGate: boolean;
	sampleSize: number;
	projectedCount: number;
	missingCount: number;
	mismatchCount: number;
	sampleCoverageRatio: number | null;
	edges: Array<{
		edgeId: string;
		sourceFactId: string;
		targetFactId: string;
		relationType: string;
		status: "current" | "missing" | "mismatched";
	}>;
};

export type GraphProjectionLifecycleDiagnostic = {
	authority: "d1";
	passesGate: boolean;
	sampleSize: number;
	projectedCount: number;
	missingCount: number;
	mismatchCount: number;
	facts: Array<{
		factId: string;
		canonicalValidTo: string | null;
		projectedValidTo: string | null;
		canonicalArchivedAt: string | null;
		projectedArchivedAt: string | null;
		status: "current" | "missing" | "mismatched";
	}>;
};

export type GraphProjectionManagedCountDiagnostic = {
	authority: "d1";
	passesGate: boolean;
	canonical: GraphProjectionManagedCounts;
	projected: GraphProjectionManagedCounts;
	mismatches: Array<{
		kind: keyof GraphProjectionManagedCounts;
		canonicalCount: number;
		projectedCount: number;
		delta: number;
	}>;
};

export function assessGraphProjectionManagedCounts(input: {
	canonical: GraphProjectionManagedCounts;
	projected: GraphProjectionManagedCounts;
	transportHealthy: boolean;
}): GraphProjectionManagedCountDiagnostic {
	const mismatches = (
		Object.keys(input.canonical) as Array<keyof GraphProjectionManagedCounts>
	)
		.map((kind) => ({
			kind,
			canonicalCount: input.canonical[kind],
			projectedCount: input.projected[kind],
			delta: input.projected[kind] - input.canonical[kind],
		}))
		.filter((item) => item.delta !== 0);
	return {
		authority: "d1",
		passesGate: input.transportHealthy && mismatches.length === 0,
		canonical: input.canonical,
		projected: input.projected,
		mismatches,
	};
}

export async function readGraphProjectionManagedCounts(
	env: CloudflareEnv,
	orgId: string,
): Promise<GraphProjectionManagedCounts> {
	const [row] = await runCypherWithParams(
		env,
		`
		CALL { MATCH (n:Fact {orgId: $orgId}) RETURN count(n) AS facts }
		CALL {
			MATCH (:Fact {orgId: $orgId})-[r]->(:Fact {orgId: $orgId})
			WHERE type(r) IN ['CAUSED_BY', 'CONTRADICTS', 'SUPERSEDES', 'APPLIES_TO', 'LEARNED_FROM', 'REQUIRES', 'RELATED_TO', 'PROMOTED_FROM']
			RETURN count(r) AS edges
		}
		CALL { MATCH (n:Domain {orgId: $orgId}) RETURN count(n) AS domains }
		CALL { MATCH (n:Tedi {orgId: $orgId}) RETURN count(n) AS tedis }
		CALL { MATCH (n:Decision {orgId: $orgId}) RETURN count(n) AS decisions }
		CALL { MATCH (n:Outcome {orgId: $orgId}) RETURN count(n) AS decisionOutcomes }
		CALL {
			MATCH (:Decision {orgId: $orgId})-[r:DECIDED_BY]->(:Tedi {orgId: $orgId})
			RETURN count(r) AS decisionOwners
		}
		CALL {
			MATCH (:Decision {orgId: $orgId})-[r:COMPLETED_AS]->(:Outcome {orgId: $orgId})
			RETURN count(r) AS decisionCompletions
		}
		CALL { MATCH (n:KnowledgeEntry {orgId: $orgId}) RETURN count(n) AS knowledgeEntries }
		CALL { MATCH (n:Skill {orgId: $orgId}) RETURN count(n) AS skills }
		CALL {
			MATCH (:Tedi {orgId: $orgId})-[r:EXPERT_IN]->(:Domain {orgId: $orgId})
			RETURN count(r) AS tediExpertise
		}
		CALL { MATCH (n:Capability {orgId: $orgId}) RETURN count(n) AS capabilities }
		CALL {
			MATCH (source {orgId: $orgId})-[r:SUPPORTS]->(:Capability {orgId: $orgId})
			RETURN count(r) AS capabilityLinks
		}
		CALL { MATCH (n:Entity {orgId: $orgId}) RETURN count(n) AS entities }
		CALL { MATCH (n:EntityResolution {orgId: $orgId}) RETURN count(n) AS entityResolutions }
		RETURN facts, edges, domains, tedis, decisions, decisionOutcomes,
			decisionOwners, decisionCompletions, knowledgeEntries, skills,
			tediExpertise, capabilities, capabilityLinks, entities, entityResolutions
		`,
		{ orgId },
	);
	const value = (key: keyof GraphProjectionManagedCounts) =>
		Number(row?.[key] ?? 0);
	return {
		facts: value("facts"),
		edges: value("edges"),
		domains: value("domains"),
		tedis: value("tedis"),
		decisions: value("decisions"),
		decisionOutcomes: value("decisionOutcomes"),
		decisionOwners: value("decisionOwners"),
		decisionCompletions: value("decisionCompletions"),
		knowledgeEntries: value("knowledgeEntries"),
		skills: value("skills"),
		tediExpertise: value("tediExpertise"),
		capabilities: value("capabilities"),
		capabilityLinks: value("capabilityLinks"),
		entities: value("entities"),
		entityResolutions: value("entityResolutions"),
	};
}

function parseTimestamp(value: string | null): number | null {
	if (!value) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function latestTimestamp(values: Array<string | null>): string | null {
	let latest: { value: string; timestamp: number } | null = null;
	for (const value of values) {
		const timestamp = parseTimestamp(value);
		if (
			value &&
			timestamp !== null &&
			(!latest || timestamp > latest.timestamp)
		) {
			latest = { value, timestamp };
		}
	}
	return latest?.value ?? null;
}

export function assessGraphProjectionCoverage(input: {
	canonicalFacts: GraphProjectionCanonicalFact[];
	projectedFacts: GraphProjectionRow[];
	configured: boolean;
	transportHealthy: boolean;
	checkedAt?: string;
	sampleLimit: number;
	minSampleCoverageRatio?: number;
	maxProjectionLagMs?: number;
}): GraphProjectionCoverageDiagnostic {
	const checkedAt = input.checkedAt ?? new Date().toISOString();
	const checkedAtMs = parseTimestamp(checkedAt) ?? Date.now();
	const minSampleCoverageRatio =
		input.minSampleCoverageRatio ?? GRAPH_PROJECTION_MIN_SAMPLE_COVERAGE_RATIO;
	const maxProjectionLagMs =
		input.maxProjectionLagMs ?? GRAPH_PROJECTION_MAX_LAG_MS;
	const projectedByFactId = new Map(
		input.projectedFacts.map((row) => [row.factId, row]),
	);

	const facts = input.canonicalFacts.map((canonical) => {
		const projected = projectedByFactId.get(canonical.id);
		const projectedAt = projected?.projectedUpdatedAt ?? null;
		const canonicalAtMs = parseTimestamp(canonical.canonicalUpdatedAt);
		const projectedAtMs = parseTimestamp(projectedAt);
		const ageMs =
			canonicalAtMs === null ? null : Math.max(0, checkedAtMs - canonicalAtMs);
		const lagMs =
			canonicalAtMs === null || projectedAtMs === null
				? null
				: Math.max(0, canonicalAtMs - projectedAtMs);

		let status: GraphProjectionFactDiagnostic["status"];
		if (!projected?.projectedFactId) {
			status =
				ageMs !== null && ageMs <= maxProjectionLagMs
					? "within_lag_allowance"
					: "missing_overdue";
		} else if (projectedAtMs === null) {
			status = "stale_overdue";
		} else if (lagMs !== null && lagMs > maxProjectionLagMs) {
			status = "stale_overdue";
		} else if (lagMs !== null && lagMs > 0) {
			status = "within_lag_allowance";
		} else {
			status = "current";
		}

		return {
			factId: canonical.id,
			canonicalUpdatedAt: canonical.canonicalUpdatedAt,
			projectedUpdatedAt: projectedAt,
			lagMs,
			status,
		};
	});

	const projectedCount = facts.filter(
		(fact) => projectedByFactId.get(fact.factId)?.projectedFactId,
	).length;
	const missingCount = facts.length - projectedCount;
	const staleCount = facts.filter(
		(fact) =>
			Boolean(projectedByFactId.get(fact.factId)?.projectedFactId) &&
			fact.status === "stale_overdue",
	).length;
	const overdueCount = facts.filter((fact) =>
		["missing_overdue", "stale_overdue"].includes(fact.status),
	).length;
	const sampleCoverageRatio =
		facts.length === 0 ? null : projectedCount / facts.length;
	const observedLag = facts
		.map((fact) => fact.lagMs)
		.filter((lag): lag is number => lag !== null);

	let gateStatus: GraphProjectionCoverageDiagnostic["gateStatus"];
	if (!input.configured || !input.transportHealthy) {
		gateStatus = "unavailable";
	} else if (facts.length === 0) {
		gateStatus = "insufficient_data";
	} else if (
		(sampleCoverageRatio ?? 0) >= minSampleCoverageRatio &&
		overdueCount === 0
	) {
		gateStatus = "passing";
	} else {
		gateStatus = "failing";
	}

	return {
		authority: "d1",
		gateStatus,
		passesGate: gateStatus === "passing",
		checkedAt,
		sampleLimit: input.sampleLimit,
		sampleSize: facts.length,
		projectedCount,
		missingCount,
		staleCount,
		overdueCount,
		sampleCoverageRatio,
		newestCanonicalAt: latestTimestamp(
			facts.map((fact) => fact.canonicalUpdatedAt),
		),
		newestProjectedAt: latestTimestamp(
			facts.map((fact) => fact.projectedUpdatedAt),
		),
		maxObservedLagMs:
			observedLag.length === 0 ? null : Math.max(...observedLag),
		thresholds: { minSampleCoverageRatio, maxProjectionLagMs },
		facts,
	};
}

export function assessGraphProjectionEdgeParity(input: {
	canonicalEdges: GraphProjectionCanonicalEdge[];
	projectedEdges: GraphProjectionEdgeRow[];
	transportHealthy: boolean;
}): GraphProjectionEdgeDiagnostic {
	const projectedById = new Map(
		input.projectedEdges.map((edge) => [edge.edgeId, edge]),
	);
	const edges = input.canonicalEdges.map((canonical) => {
		const projected = projectedById.get(canonical.id);
		let status: "current" | "missing" | "mismatched";
		if (!projected?.projectedEdgeId) {
			status = "missing";
		} else if (
			projected.projectedSourceFactId !== canonical.sourceFactId ||
			projected.projectedTargetFactId !== canonical.targetFactId ||
			projected.projectedRelationType !== canonical.relationType
		) {
			status = "mismatched";
		} else {
			status = "current";
		}
		return {
			edgeId: canonical.id,
			sourceFactId: canonical.sourceFactId,
			targetFactId: canonical.targetFactId,
			relationType: canonical.relationType,
			status,
		};
	});
	const projectedCount = edges.filter(
		(edge) => edge.status !== "missing",
	).length;
	const missingCount = edges.filter((edge) => edge.status === "missing").length;
	const mismatchCount = edges.filter(
		(edge) => edge.status === "mismatched",
	).length;
	return {
		authority: "d1",
		passesGate:
			input.transportHealthy && missingCount === 0 && mismatchCount === 0,
		sampleSize: edges.length,
		projectedCount,
		missingCount,
		mismatchCount,
		sampleCoverageRatio:
			edges.length === 0 ? null : projectedCount / edges.length,
		edges,
	};
}

export function assessGraphProjectionLifecycleParity(input: {
	canonicalFacts: GraphProjectionCanonicalLifecycleFact[];
	projectedFacts: GraphProjectionRow[];
	transportHealthy: boolean;
}): GraphProjectionLifecycleDiagnostic {
	const projectedById = new Map(
		input.projectedFacts.map((fact) => [fact.factId, fact]),
	);
	const facts = input.canonicalFacts.map((canonical) => {
		const projected = projectedById.get(canonical.id);
		let status: "current" | "missing" | "mismatched";
		if (!projected?.projectedFactId) {
			status = "missing";
		} else if (
			projected.projectedValidTo !== canonical.validTo ||
			projected.projectedArchivedAt !== canonical.archivedAt
		) {
			status = "mismatched";
		} else {
			status = "current";
		}
		return {
			factId: canonical.id,
			canonicalValidTo: canonical.validTo,
			projectedValidTo: projected?.projectedValidTo ?? null,
			canonicalArchivedAt: canonical.archivedAt,
			projectedArchivedAt: projected?.projectedArchivedAt ?? null,
			status,
		};
	});
	const projectedCount = facts.filter(
		(fact) => fact.status !== "missing",
	).length;
	const missingCount = facts.filter((fact) => fact.status === "missing").length;
	const mismatchCount = facts.filter(
		(fact) => fact.status === "mismatched",
	).length;
	return {
		authority: "d1",
		passesGate:
			input.transportHealthy && missingCount === 0 && mismatchCount === 0,
		sampleSize: facts.length,
		projectedCount,
		missingCount,
		mismatchCount,
		facts,
	};
}

export async function readGraphProjectionRows(
	env: CloudflareEnv,
	orgId: string,
	factIds: string[],
): Promise<GraphProjectionRow[]> {
	if (factIds.length === 0) return [];
	const rows = await runCypherWithParams(
		env,
		`UNWIND $factIds AS factId
		 OPTIONAL MATCH (f:Fact {id: factId, orgId: $orgId})
		 RETURN factId,
		        f.id AS projectedFactId,
		        toString(f.updatedAt) AS projectedUpdatedAt,
		        toString(f.validTo) AS projectedValidTo,
		        toString(f.archivedAt) AS projectedArchivedAt`,
		{ orgId, factIds },
	);

	return rows.map((row) => ({
		factId: String(row.factId),
		projectedFactId:
			typeof row.projectedFactId === "string" ? row.projectedFactId : null,
		projectedUpdatedAt:
			typeof row.projectedUpdatedAt === "string"
				? row.projectedUpdatedAt
				: null,
		projectedValidTo:
			typeof row.projectedValidTo === "string" ? row.projectedValidTo : null,
		projectedArchivedAt:
			typeof row.projectedArchivedAt === "string"
				? row.projectedArchivedAt
				: null,
	}));
}

export async function readGraphProjectionEdgeRows(
	env: CloudflareEnv,
	orgId: string,
	edges: GraphProjectionCanonicalEdge[],
): Promise<GraphProjectionEdgeRow[]> {
	if (edges.length === 0) return [];
	const rows = await runCypherWithParams(
		env,
		`UNWIND $edges AS edge
		 OPTIONAL MATCH (source:Fact {id: edge.sourceFactId, orgId: $orgId})
		                -[r]->
		                (target:Fact {id: edge.targetFactId, orgId: $orgId})
		 WHERE r.id = edge.id AND r.orgId = $orgId
		 RETURN edge.id AS edgeId,
		        r.id AS projectedEdgeId,
		        source.id AS projectedSourceFactId,
		        target.id AS projectedTargetFactId,
		        r.relationType AS projectedRelationType`,
		{
			orgId,
			edges: edges.map((edge) => ({
				id: edge.id,
				sourceFactId: edge.sourceFactId,
				targetFactId: edge.targetFactId,
			})),
		},
	);

	return rows.map((row) => ({
		edgeId: String(row.edgeId),
		projectedEdgeId:
			typeof row.projectedEdgeId === "string" ? row.projectedEdgeId : null,
		projectedSourceFactId:
			typeof row.projectedSourceFactId === "string"
				? row.projectedSourceFactId
				: null,
		projectedTargetFactId:
			typeof row.projectedTargetFactId === "string"
				? row.projectedTargetFactId
				: null,
		projectedRelationType:
			typeof row.projectedRelationType === "string"
				? row.projectedRelationType
				: null,
	}));
}
