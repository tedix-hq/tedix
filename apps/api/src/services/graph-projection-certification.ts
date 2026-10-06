/// <reference path="../../worker-configuration.d.ts" />

import type { DbClient } from "@tedix/db/client";
import {
	type GraphProjectionBacklogStats,
	type GraphProjectionReadState,
	getGraphProjectionBacklogStats,
	getGraphProjectionReadState,
	setGraphProjectionReadiness,
} from "@tedix/db/queries/graph-projection";
import {
	GRAPH_PROJECTION_EDGE_SAMPLE_LIMIT,
	GRAPH_PROJECTION_LIFECYCLE_SAMPLE_LIMIT,
	GRAPH_PROJECTION_SAMPLE_LIMIT,
	type GraphProjectionManagedCounts,
	getGraphProjectionCanonicalEdgeSample,
	getGraphProjectionCanonicalLifecycleSample,
	getGraphProjectionCanonicalManagedCounts,
	getGraphProjectionCanonicalSample,
} from "@tedix/db/queries/graph-projection-health";
import { getGraphClient } from "../integrations/graph-db/client";
import {
	assessGraphProjectionCoverage,
	assessGraphProjectionEdgeParity,
	assessGraphProjectionLifecycleParity,
	assessGraphProjectionManagedCounts,
	type GraphProjectionCoverageDiagnostic,
	type GraphProjectionEdgeDiagnostic,
	type GraphProjectionLifecycleDiagnostic,
	type GraphProjectionManagedCountDiagnostic,
	readGraphProjectionEdgeRows,
	readGraphProjectionManagedCounts,
	readGraphProjectionRows,
} from "../integrations/graph-projection-health";
import {
	GRAPH_PROJECTION_SCHEMA_VERSION,
	type GraphProjectionSchemaState,
	readGraphProjectionSchemaState,
} from "./graph-projection-schema";

export const GRAPH_PROJECTION_CERTIFICATION_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export type GraphProjectionInspection = {
	configured: boolean;
	transportHealthy: boolean;
	checkedAt: string;
	readiness: GraphProjectionReadState | null;
	backlog: GraphProjectionBacklogStats;
	facts: GraphProjectionCoverageDiagnostic;
	edges: GraphProjectionEdgeDiagnostic;
	lifecycle: GraphProjectionLifecycleDiagnostic;
	managedCounts: GraphProjectionManagedCountDiagnostic;
	schema: GraphProjectionSchemaState;
	parityPasses: boolean;
};

const EMPTY_MANAGED_COUNTS: GraphProjectionManagedCounts = {
	facts: 0,
	edges: 0,
	domains: 0,
	tedis: 0,
	decisions: 0,
	decisionOutcomes: 0,
	decisionOwners: 0,
	decisionCompletions: 0,
	knowledgeEntries: 0,
	skills: 0,
	tediExpertise: 0,
	capabilities: 0,
	capabilityLinks: 0,
	entities: 0,
	entityResolutions: 0,
};

export async function inspectGraphProjection(input: {
	db: DbClient;
	env: CloudflareEnv;
	organizationId: string;
	checkedAt?: string;
}): Promise<GraphProjectionInspection> {
	const checkedAt = input.checkedAt ?? new Date().toISOString();
	const [
		canonicalFacts,
		canonicalEdges,
		canonicalLifecycle,
		canonicalManagedCounts,
		readiness,
		backlog,
	] = await Promise.all([
		getGraphProjectionCanonicalSample(
			input.db,
			input.organizationId,
			GRAPH_PROJECTION_SAMPLE_LIMIT,
		),
		getGraphProjectionCanonicalEdgeSample(
			input.db,
			input.organizationId,
			GRAPH_PROJECTION_EDGE_SAMPLE_LIMIT,
		),
		getGraphProjectionCanonicalLifecycleSample(
			input.db,
			input.organizationId,
			GRAPH_PROJECTION_LIFECYCLE_SAMPLE_LIMIT,
		),
		getGraphProjectionCanonicalManagedCounts(input.db, input.organizationId),
		getGraphProjectionReadState(input.db, input.organizationId),
		getGraphProjectionBacklogStats(input.db, input.organizationId),
	]);
	const graphClient = getGraphClient(input.env);
	const configured = graphClient !== null;
	const transportHealthy = graphClient
		? await graphClient.isHealthy().catch(() => false)
		: false;
	let projectedFacts: Awaited<ReturnType<typeof readGraphProjectionRows>> = [];
	let projectedLifecycle: Awaited<ReturnType<typeof readGraphProjectionRows>> =
		[];
	let projectedEdges: Awaited<ReturnType<typeof readGraphProjectionEdgeRows>> =
		[];
	let projectedManagedCounts = EMPTY_MANAGED_COUNTS;
	let schema: GraphProjectionSchemaState = {
		version: GRAPH_PROJECTION_SCHEMA_VERSION,
		constraints: [],
		complete: false,
	};
	let projectionReadable = transportHealthy;
	if (transportHealthy) {
		try {
			[
				projectedFacts,
				projectedLifecycle,
				projectedEdges,
				projectedManagedCounts,
				schema,
			] = await Promise.all([
				readGraphProjectionRows(
					input.env,
					input.organizationId,
					canonicalFacts.map((fact) => fact.id),
				),
				readGraphProjectionRows(
					input.env,
					input.organizationId,
					canonicalLifecycle.map((fact) => fact.id),
				),
				readGraphProjectionEdgeRows(
					input.env,
					input.organizationId,
					canonicalEdges,
				),
				readGraphProjectionManagedCounts(input.env, input.organizationId),
				readGraphProjectionSchemaState(input.env),
			]);
		} catch (error) {
			projectionReadable = false;
			console.warn("[GraphDB] Projection certification read failed:", error);
		}
	}
	const facts = assessGraphProjectionCoverage({
		canonicalFacts,
		projectedFacts,
		configured,
		transportHealthy: projectionReadable,
		checkedAt,
		sampleLimit: GRAPH_PROJECTION_SAMPLE_LIMIT,
	});
	const edges = assessGraphProjectionEdgeParity({
		canonicalEdges,
		projectedEdges,
		transportHealthy: projectionReadable,
	});
	const lifecycle = assessGraphProjectionLifecycleParity({
		canonicalFacts: canonicalLifecycle,
		projectedFacts: projectedLifecycle,
		transportHealthy: projectionReadable,
	});
	const managedCounts = assessGraphProjectionManagedCounts({
		canonical: canonicalManagedCounts,
		projected: projectedManagedCounts,
		transportHealthy: projectionReadable,
	});
	return {
		configured,
		transportHealthy,
		checkedAt,
		readiness,
		backlog,
		facts,
		edges,
		lifecycle,
		managedCounts,
		schema,
		parityPasses:
			facts.passesGate &&
			edges.passesGate &&
			lifecycle.passesGate &&
			managedCounts.passesGate &&
			schema.complete,
	};
}

export async function certifyGraphProjection(input: {
	db: DbClient;
	env: CloudflareEnv;
	organizationId: string;
	checkedAt?: string;
}): Promise<GraphProjectionInspection> {
	const inspection = await inspectGraphProjection(input);
	const { backlog } = inspection;
	const poisoned = backlog.poisonedCount > 0;
	const caughtUp =
		backlog.pendingCount === 0 && backlog.cursor >= backlog.highWaterSequence;
	const baselineComplete =
		inspection.readiness?.repairPhase === "complete" &&
		inspection.readiness.repairHighWater !== null &&
		backlog.cursor >= inspection.readiness.repairHighWater;
	const generationPresent = Boolean(inspection.readiness?.projectionEpoch);
	const ready =
		inspection.configured &&
		inspection.transportHealthy &&
		caughtUp &&
		baselineComplete &&
		generationPresent &&
		!poisoned &&
		inspection.parityPasses;
	const state = ready
		? "ready"
		: poisoned || (!inspection.transportHealthy && inspection.configured)
			? "degraded"
			: inspection.configured
				? "catching_up"
				: "disabled";
	const reasons = [
		!inspection.configured ? "neo4j_not_configured" : null,
		inspection.configured && !inspection.transportHealthy
			? "neo4j_unreachable"
			: null,
		poisoned ? `poisoned_events:${backlog.poisonedCount}` : null,
		!caughtUp
			? `outbox_backlog:${backlog.pendingCount}@${backlog.cursor}/${backlog.highWaterSequence}`
			: null,
		!baselineComplete ? "baseline_repair_incomplete" : null,
		!generationPresent ? "projection_generation_missing" : null,
		!inspection.facts.passesGate ? "fact_parity_failed" : null,
		!inspection.edges.passesGate ? "edge_parity_failed" : null,
		!inspection.lifecycle.passesGate ? "lifecycle_parity_failed" : null,
		!inspection.managedCounts.passesGate ? "managed_count_parity_failed" : null,
		!inspection.schema.complete ? "neo4j_schema_incomplete" : null,
	].filter((reason): reason is string => Boolean(reason));
	const managedRelationKinds = new Set([
		"edges",
		"decisionOwners",
		"decisionCompletions",
		"tediExpertise",
		"capabilityLinks",
	]);
	const managedNodeCountMismatch = inspection.managedCounts.mismatches
		.filter((item) => !managedRelationKinds.has(item.kind))
		.reduce((sum, item) => sum + Math.abs(item.delta), 0);
	const managedEdgeCountMismatch = inspection.managedCounts.mismatches
		.filter((item) => managedRelationKinds.has(item.kind))
		.reduce((sum, item) => sum + Math.abs(item.delta), 0);
	await setGraphProjectionReadiness(input.db, {
		organizationId: input.organizationId,
		state,
		reason: ready ? null : reasons.join(","),
		persistedWatermark: backlog.cursor,
		nodeMismatchCount:
			inspection.facts.missingCount +
			inspection.facts.staleCount +
			managedNodeCountMismatch,
		edgeMismatchCount:
			inspection.edges.missingCount +
			inspection.edges.mismatchCount +
			managedEdgeCountMismatch,
		lifecycleMismatchCount:
			inspection.lifecycle.missingCount + inspection.lifecycle.mismatchCount,
		certified: ready,
	});
	return {
		...inspection,
		readiness: await getGraphProjectionReadState(
			input.db,
			input.organizationId,
		),
	};
}

export function graphProjectionReadAdmission(input: {
	inspection: Pick<
		GraphProjectionInspection,
		"backlog" | "checkedAt" | "readiness" | "transportHealthy"
	>;
	maxCertificationAgeMs?: number;
	requiresGds?: boolean;
}): { allowed: boolean; reason: string | null } {
	const { inspection } = input;
	if (!inspection.transportHealthy) {
		return { allowed: false, reason: "neo4j_unreachable" };
	}
	if (inspection.readiness?.state !== "ready") {
		return {
			allowed: false,
			reason: inspection.readiness?.reason ?? "projection_not_certified",
		};
	}
	if (
		inspection.readiness.repairPhase !== "complete" ||
		inspection.readiness.repairHighWater === null ||
		inspection.backlog.cursor < inspection.readiness.repairHighWater
	) {
		return { allowed: false, reason: "baseline_repair_incomplete" };
	}
	if (inspection.backlog.poisonedCount > 0) {
		return { allowed: false, reason: "projection_poisoned" };
	}
	const certifiedAt = Date.parse(inspection.readiness.lastCertifiedAt ?? "");
	const checkedAt = Date.parse(inspection.checkedAt);
	const maxAge =
		input.maxCertificationAgeMs ?? GRAPH_PROJECTION_CERTIFICATION_MAX_AGE_MS;
	if (
		!Number.isFinite(certifiedAt) ||
		!Number.isFinite(checkedAt) ||
		checkedAt - certifiedAt > maxAge
	) {
		return { allowed: false, reason: "projection_certification_stale" };
	}
	if (inspection.backlog.pendingCount > 0) {
		return { allowed: false, reason: "projection_backlog_pending" };
	}
	if (inspection.backlog.cursor < inspection.backlog.highWaterSequence) {
		return { allowed: false, reason: "projection_cursor_behind" };
	}
	if (inspection.readiness.persistedWatermark !== inspection.backlog.cursor) {
		return { allowed: false, reason: "projection_watermark_mismatch" };
	}
	if (!inspection.readiness.projectionEpoch) {
		return { allowed: false, reason: "projection_generation_missing" };
	}
	if (input.requiresGds) {
		if (
			inspection.readiness.gdsWatermark !==
			inspection.readiness.persistedWatermark
		) {
			return { allowed: false, reason: "gds_watermark_stale" };
		}
		if (
			inspection.readiness.gdsEpoch !== inspection.readiness.projectionEpoch
		) {
			return { allowed: false, reason: "gds_epoch_stale" };
		}
	}
	return { allowed: true, reason: null };
}
