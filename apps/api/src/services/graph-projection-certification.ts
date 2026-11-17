/// <reference path="../../worker-configuration.d.ts" />

import { safeExceptionTopology } from "../lib/safe-log-metadata";
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
	type GraphProjectionManagedCountAttempt,
	type GraphProjectionManagedCounts,
	clearGraphProjectionManagedCountAttempt,
	getGraphProjectionCanonicalEdgeSample,
	getGraphProjectionCanonicalLifecycleSample,
	getGraphProjectionCanonicalManagedCounts,
	getGraphProjectionCanonicalSample,
	getGraphProjectionManagedCountAttempt,
	recordGraphProjectionManagedCountAttempt,
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
	/** Where `managedCounts` came from, for the certification that follows. */
	managedCountCheck: {
		source: "counted" | "reused" | "skipped";
		/** Whether the projection side was read, so the two sides were compared. */
		compared: boolean;
		previous: GraphProjectionManagedCountAttempt | null;
	};
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

/**
 * The exact managed-count inventory reads every canonical row of the org
 * (34k rationale records and 30k facts per check for the largest org on
 * 2026-10-12), so the drain's per-tick certification runs it once per UTC
 * hour. A count that does not certify leaves `lastCertifiedAt` in the earlier
 * hour; `managedCountStep` decides whether the next tick counts again.
 */
export function managedCountsDue(
	lastCertifiedAt: string | null | undefined,
	checkedAt: string,
): boolean {
	return lastCertifiedAt?.slice(0, 13) !== checkedAt.slice(0, 13);
}

/** Inventories in a row that may fail to certify before ticks stop recounting for the hour. */
export const GRAPH_PROJECTION_MANAGED_COUNT_QUICK_RETRIES = 3;

/**
 * What a drain tick does about the exact inventory once certification is
 * possible. An inventory that does not certify is repeated on the next tick,
 * so a count that raced a write recovers within minutes. After
 * GRAPH_PROJECTION_MANAGED_COUNT_QUICK_RETRIES such inventories in a row the
 * tick reuses the stored counts until the next UTC hour: a projection that
 * stayed out of parity was otherwise counted on every two-minute tick (749
 * inventories of about 200k rows each on 16 Nov 2026).
 */
export function managedCountStep(input: {
	lastCertifiedAt: string | null | undefined;
	checkedAt: string;
	previous: Pick<
		GraphProjectionManagedCountAttempt,
		"checkedAt" | "attempts"
	> | null;
}): "skip" | "count" | "reuse" {
	if (!managedCountsDue(input.lastCertifiedAt, input.checkedAt)) return "skip";
	const { previous } = input;
	return previous &&
		previous.attempts >= GRAPH_PROJECTION_MANAGED_COUNT_QUICK_RETRIES &&
		previous.checkedAt.slice(0, 13) === input.checkedAt.slice(0, 13)
		? "reuse"
		: "count";
}

type ReadState = Awaited<ReturnType<typeof getGraphProjectionReadState>>;
type BacklogStats = Awaited<ReturnType<typeof getGraphProjectionBacklogStats>>;

/** The stored-state conditions a projection must meet before parity can certify it. */
export function projectionBacklogState(
	readiness: ReadState,
	backlog: BacklogStats,
) {
	const caughtUp =
		backlog.pendingCount === 0 && backlog.cursor >= backlog.highWaterSequence;
	const baselineComplete =
		readiness?.repairPhase === "complete" &&
		readiness.repairHighWater !== null &&
		backlog.cursor >= readiness.repairHighWater;
	const generationPresent = Boolean(readiness?.projectionEpoch);
	const poisoned = backlog.poisonedCount > 0;
	return {
		caughtUp,
		baselineComplete,
		generationPresent,
		poisoned,
		certifiable: caughtUp && baselineComplete && generationPresent && !poisoned,
	};
}

export async function inspectGraphProjection(input: {
	db: DbClient;
	env: CloudflareEnv;
	organizationId: string;
	checkedAt?: string;
	/** "hourly" skips the exact inventory when this hour already certified. */
	managedCounts?: "exact" | "hourly";
}): Promise<GraphProjectionInspection> {
	const checkedAt = input.checkedAt ?? new Date().toISOString();
	const readiness = await getGraphProjectionReadState(
		input.db,
		input.organizationId,
	);
	const backlog = await getGraphProjectionBacklogStats(
		input.db,
		input.organizationId,
	);
	const graphClient = getGraphClient(input.env);
	const configured = graphClient !== null;
	const transportHealthy = graphClient
		? await graphClient.isHealthy().catch(() => false)
		: false;
	// A drain tick cannot certify while the projection is unconfigured,
	// unreachable, behind or unrepaired, so the inventory would only repeat a
	// known "not ready".
	let managedCountSource: GraphProjectionInspection["managedCountCheck"]["source"] =
		"counted";
	let previousAttempt: GraphProjectionManagedCountAttempt | null = null;
	if (input.managedCounts === "hourly") {
		managedCountSource = "skipped";
		if (
			configured &&
			transportHealthy &&
			projectionBacklogState(readiness, backlog).certifiable &&
			managedCountsDue(readiness?.lastCertifiedAt, checkedAt)
		) {
			previousAttempt = await getGraphProjectionManagedCountAttempt(
				input.db,
				input.organizationId,
			);
			managedCountSource =
				managedCountStep({
					lastCertifiedAt: readiness?.lastCertifiedAt,
					checkedAt,
					previous: previousAttempt,
				}) === "reuse"
					? "reused"
					: "counted";
		}
	}
	const countManaged = managedCountSource === "counted";
	const reusedAttempt =
		managedCountSource === "reused" ? previousAttempt : null;
	const [
		canonicalFacts,
		canonicalEdges,
		canonicalLifecycle,
		canonicalManagedCounts,
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
		countManaged
			? getGraphProjectionCanonicalManagedCounts(input.db, input.organizationId)
			: (reusedAttempt?.canonical ?? EMPTY_MANAGED_COUNTS),
	]);
	let projectedFacts: Awaited<ReturnType<typeof readGraphProjectionRows>> = [];
	let projectedLifecycle: Awaited<ReturnType<typeof readGraphProjectionRows>> =
		[];
	let projectedEdges: Awaited<ReturnType<typeof readGraphProjectionEdgeRows>> =
		[];
	let projectedManagedCounts = reusedAttempt?.projected ?? EMPTY_MANAGED_COUNTS;
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
				countManaged
					? readGraphProjectionManagedCounts(input.env, input.organizationId)
					: projectedManagedCounts,
				readGraphProjectionSchemaState(input.env),
			]);
		} catch (error) {
			projectionReadable = false;
			console.warn("[GraphDB] Projection certification read failed", {
				exception: safeExceptionTopology(error),
			});
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
	// Reused counts stand for the tick that took them: if that tick could not
	// read the projection, nothing was compared and the gate stays closed.
	const managedCountsCompared =
		projectionReadable && (reusedAttempt?.compared ?? true);
	const managedCounts = assessGraphProjectionManagedCounts({
		canonical: canonicalManagedCounts,
		projected: projectedManagedCounts,
		transportHealthy: managedCountsCompared,
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
		managedCountCheck: {
			source: managedCountSource,
			compared: managedCountsCompared,
			previous: previousAttempt,
		},
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
	managedCounts?: "exact" | "hourly";
}): Promise<GraphProjectionInspection> {
	const inspection = await inspectGraphProjection(input);
	const { backlog } = inspection;
	const { poisoned, caughtUp, baselineComplete, generationPresent } =
		projectionBacklogState(inspection.readiness, backlog);
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
	if (input.managedCounts === "hourly") {
		const { source, compared, previous } = inspection.managedCountCheck;
		if (ready) {
			if (previous)
				await clearGraphProjectionManagedCountAttempt(
					input.db,
					input.organizationId,
				);
		} else if (source === "counted") {
			await recordGraphProjectionManagedCountAttempt(
				input.db,
				input.organizationId,
				{
					checkedAt: inspection.checkedAt,
					attempts: (previous?.attempts ?? 0) + 1,
					canonical: inspection.managedCounts.canonical,
					projected: inspection.managedCounts.projected,
					compared,
				},
			);
		}
	}
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
