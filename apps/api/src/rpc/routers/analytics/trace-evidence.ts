import type {
	ActivityReviewGroup,
	CognitionEvidenceBundle,
	TraceEvidenceCoverage,
	TraceEvidenceSummary,
	TraceFreshnessCoverage,
} from "@tedix/api-contract/schemas/analytics";
import { extractFactIdsFromEvidence } from "@tedix/api-contract/utils/fact-evidence";
import {
	listAnalyticsRationaleEvidence,
	listAnalyticsRuntimeTraceEvidence,
} from "@tedix/db/queries/analytics-audit";
import {
	type CloudflareTraceEvidence,
	hasWorkersObservabilityConfig,
	queryWorkersTraceEvidence,
} from "../../../lib/workers-observability";
import { type BaseContext } from "../../orpc";
import { uniqueStrings } from "./audit-resources";

const cognitiveTraceEventKinds = new Set([
	"memory.observed",
	"memory.bridged",
	"memory.retrieved",
	"decision.recorded",
	"decision.completed",
	"skill.used",
	"skill.crystallized",
	"task.detected",
	"task.synced",
	"approval.requested",
	"approval.resolved",
	"context.injected",
	"context.compacted",
]);

const ACTIVITY_REVIEW_TRACE_PROOF_TARGET = 0.8;

const ACTIVITY_REVIEW_TRACE_FRESHNESS_TARGET = 0.9;

const ACTIVITY_REVIEW_TRACE_FRESHNESS_MAX_LAG_MS = 5 * 60 * 1000;

const emptyCloudflareTraceEvidence =
	(): TraceEvidenceSummary["cloudflare"] => ({
		sampled: false,
		traceId: null,
		spanCount: 0,
		serviceNames: [],
		durationMs: null,
		errorCount: 0,
		traceStartAt: null,
		traceEndAt: null,
	});

export interface RuntimeTraceEvidenceRow {
	traceId: string | null;
	kind: string;
	createdAt?: Date | number | string | null;
	runtimeBackend: string;
	payload: unknown;
}

export interface DurableRationaleEvidenceRow {
	id: string;
	category: string | null;
	outcomeStatus: string | null;
	confidence: number | null;
	evidence: unknown;
	createdAt: string | null;
	completedAt: string | null;
}

export function traceEvidenceFallback(
	traceId: string | null,
): TraceEvidenceSummary {
	return {
		status: traceId ? "audit_only" : "missing_trace",
		mcpEvents: 0,
		runtimeEvents: 0,
		cognitiveEvents: 0,
		retrievalEvents: 0,
		decisionEvents: 0,
		retrievedFactCount: 0,
		citedFactCount: 0,
		ignoredFactCount: 0,
		runtimeBackends: [],
		hasRetrievalDecisionJoin: false,
		latestRuntimeAt: null,
		latestCognitiveAt: null,
		latestRetrievalAt: null,
		latestDecisionAt: null,
		cloudflare: emptyCloudflareTraceEvidence(),
		cognition: emptyCognitionEvidence(),
		warnings: traceId ? ["runtime_trace_missing"] : ["trace_missing"],
	};
}

export function markMcpTraceEvidence(
	traceEvidence: TraceEvidenceSummary,
	mcpEvents: number,
): TraceEvidenceSummary {
	if (
		mcpEvents <= 0 ||
		traceEvidence.status !== "audit_only" ||
		traceEvidence.runtimeEvents > 0
	) {
		return traceEvidence;
	}

	return {
		...traceEvidence,
		status: "mcp_linked",
		mcpEvents,
		warnings: traceEvidence.warnings.filter(
			(warning) => warning !== "runtime_trace_missing",
		),
	};
}

function asObject(value: unknown): Record<string, unknown> {
	if (!value) return {};
	if (typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	if (typeof value !== "string" || value.trim().length === 0) return {};
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function addStringValues(target: Set<string>, value: unknown): void {
	if (Array.isArray(value)) {
		for (const item of value) addStringValues(target, item);
		return;
	}
	if (typeof value === "string" && value.trim()) target.add(value.trim());
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
	return Object.hasOwn(obj, key);
}

function numberOrNull(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const numeric = Number(value);
		return Number.isFinite(numeric) ? numeric : null;
	}
	return null;
}

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sortedValues(values: Set<string>): string[] {
	return Array.from(values).sort();
}

function emptyCognitionEvidence(): CognitionEvidenceBundle {
	return {
		summary: "No cognitive evidence linked.",
		retrievedFactIds: [],
		citedFactIds: [],
		ignoredFactIds: [],
		decisionIds: [],
		latestDecision: null,
		retrieval: {
			topK: null,
			returnedCount: null,
			vectorEnabled: null,
			vectorMs: null,
			hydrateFactsMs: null,
		},
		graph: {
			status: "not_applicable",
			projectedDecisionIds: [],
			warnings: [],
		},
		warnings: [],
	};
}

function timestampMs(
	value: Date | number | string | null | undefined,
): number | null {
	if (value == null) return null;
	if (value instanceof Date) return value.getTime();
	if (typeof value === "number") {
		return new Date(value < 10_000_000_000 ? value * 1000 : value).getTime();
	}
	const numeric = Number(value);
	if (Number.isFinite(numeric)) {
		return new Date(
			numeric < 10_000_000_000 ? numeric * 1000 : numeric,
		).getTime();
	}
	const parsed = new Date(value).getTime();
	return Number.isFinite(parsed) ? parsed : null;
}

function latestIso(current: string | null, candidate: unknown): string | null {
	const candidateMs = timestampMs(
		candidate as Date | number | string | null | undefined,
	);
	if (candidateMs == null) return current;
	const currentMs = timestampMs(current);
	if (currentMs != null && currentMs >= candidateMs) return current;
	return new Date(candidateMs).toISOString();
}

function buildCognitionSummary(input: {
	retrievedFactCount: number;
	citedFactCount: number;
	ignoredFactCount: number;
	decisionCount: number;
	latestDecision: CognitionEvidenceBundle["latestDecision"];
	graph: CognitionEvidenceBundle["graph"];
}): string {
	const parts: string[] = [];
	if (input.retrievedFactCount > 0) {
		parts.push(`${input.retrievedFactCount} fact(s) retrieved`);
	}
	if (input.citedFactCount > 0 || input.ignoredFactCount > 0) {
		parts.push(
			`${input.citedFactCount} cited / ${input.ignoredFactCount} ignored`,
		);
	}
	if (input.decisionCount > 0) {
		const outcome = input.latestDecision?.outcomeStatus
			? `, ${input.latestDecision.outcomeStatus}`
			: "";
		parts.push(`${input.decisionCount} decision event(s)${outcome}`);
	}

	if (input.graph.status === "not_observed") {
		parts.push("graph projection not observed");
	}
	return parts.length > 0 ? parts.join("; ") : "No cognitive evidence linked.";
}

export function buildTraceEvidenceSummary(
	traceId: string | null,
	rows: RuntimeTraceEvidenceRow[],
): TraceEvidenceSummary {
	if (!traceId) return traceEvidenceFallback(null);
	if (rows.length === 0) return traceEvidenceFallback(traceId);

	const runtimeBackends = new Set<string>();
	const retrievedFactIds = new Set<string>();
	const citedFactIds = new Set<string>();
	const ignoredFactIds = new Set<string>();
	const decisionIds = new Set<string>();
	const projectedDecisionIds = new Set<string>();
	let cognitiveEvents = 0;
	let retrievalEvents = 0;
	let decisionEvents = 0;
	let sawDecisionFactPayload = false;
	let latestDecision: CognitionEvidenceBundle["latestDecision"] = null;
	let latestDecisionMs: number | null = null;
	let topK: number | null = null;
	let returnedCount: number | null = null;
	let vectorEnabled: boolean | null = null;
	let vectorMs: number | null = null;
	let hydrateFactsMs: number | null = null;
	let latestRuntimeAt: string | null = null;
	let latestCognitiveAt: string | null = null;
	let latestRetrievalAt: string | null = null;
	let latestDecisionAt: string | null = null;

	for (const row of rows) {
		runtimeBackends.add(row.runtimeBackend);
		latestRuntimeAt = latestIso(latestRuntimeAt, row.createdAt);
		if (cognitiveTraceEventKinds.has(row.kind)) {
			cognitiveEvents += 1;
			latestCognitiveAt = latestIso(latestCognitiveAt, row.createdAt);
		}
		const payload = asObject(row.payload);
		if (row.kind === "memory.retrieved") {
			retrievalEvents += 1;
			latestRetrievalAt = latestIso(latestRetrievalAt, row.createdAt);
			addStringValues(retrievedFactIds, payload.factIds);
			addStringValues(retrievedFactIds, payload.retrievedFactIds);
			topK = numberOrNull(payload.topK) ?? topK;
			returnedCount =
				numberOrNull(payload.returnedCount) ??
				numberOrNull(payload.returnedFactCount) ??
				returnedCount;
			vectorEnabled =
				typeof payload.vectorEnabled === "boolean"
					? payload.vectorEnabled
					: vectorEnabled;
			vectorMs = numberOrNull(payload.vectorMs) ?? vectorMs;
			hydrateFactsMs = numberOrNull(payload.hydrateFactsMs) ?? hydrateFactsMs;
		}
		if (row.kind === "decision.recorded" || row.kind === "decision.completed") {
			decisionEvents += 1;
			latestDecisionAt = latestIso(latestDecisionAt, row.createdAt);
			const rationaleRecordId = stringOrNull(payload.rationaleRecordId);
			if (rationaleRecordId) decisionIds.add(rationaleRecordId);
			if (
				hasOwn(payload, "citedFactIds") ||
				hasOwn(payload, "usedFactIds") ||
				hasOwn(payload, "ignoredFactIds")
			) {
				sawDecisionFactPayload = true;
			}
			addStringValues(citedFactIds, payload.citedFactIds);
			addStringValues(citedFactIds, payload.usedFactIds);
			addStringValues(ignoredFactIds, payload.ignoredFactIds);
			const rowMs = timestampMs(row.createdAt);
			if (
				rowMs != null &&
				(latestDecisionMs == null || rowMs >= latestDecisionMs)
			) {
				latestDecisionMs = rowMs;
				latestDecision = rationaleRecordId
					? {
							id: rationaleRecordId,
							category: stringOrNull(payload.category),
							outcomeStatus: stringOrNull(payload.outcomeStatus),
							confidence: numberOrNull(payload.confidence),
							createdAt: latestIso(null, row.createdAt),
							completedAt:
								row.kind === "decision.completed"
									? latestIso(null, row.createdAt)
									: null,
							source: "runtime",
						}
					: latestDecision;
			}
		}
		if (row.kind.startsWith("graph.")) {
			addStringValues(projectedDecisionIds, payload.decisionIds);
			addStringValues(projectedDecisionIds, payload.projectedDecisionIds);
		}
	}

	if (sawDecisionFactPayload && retrievedFactIds.size > 0) {
		for (const factId of retrievedFactIds) {
			if (!citedFactIds.has(factId)) ignoredFactIds.add(factId);
		}
	}

	const hasRetrievalDecisionJoin =
		retrievalEvents > 0 &&
		decisionEvents > 0 &&
		(citedFactIds.size > 0 || ignoredFactIds.size > 0);
	const cognitionWarnings: string[] = [];
	const graph: CognitionEvidenceBundle["graph"] =
		decisionIds.size === 0
			? { status: "not_applicable", projectedDecisionIds: [], warnings: [] }
			: projectedDecisionIds.size > 0
				? {
						status: "observed",
						projectedDecisionIds: sortedValues(projectedDecisionIds),
						warnings: [],
					}
				: {
						status: "not_observed",
						projectedDecisionIds: [],
						warnings: ["graph_projection_not_observed"],
					};

	const cognition: CognitionEvidenceBundle = {
		summary: buildCognitionSummary({
			retrievedFactCount: retrievedFactIds.size,
			citedFactCount: citedFactIds.size,
			ignoredFactCount: ignoredFactIds.size,
			decisionCount: decisionEvents,
			latestDecision,
			graph,
		}),
		retrievedFactIds: sortedValues(retrievedFactIds),
		citedFactIds: sortedValues(citedFactIds),
		ignoredFactIds: sortedValues(ignoredFactIds),
		decisionIds: sortedValues(decisionIds),
		latestDecision,
		retrieval: {
			topK,
			returnedCount,
			vectorEnabled,
			vectorMs,
			hydrateFactsMs,
		},
		graph,
		warnings: [...cognitionWarnings, ...graph.warnings],
	};
	const warnings: string[] = [];
	if (cognitiveEvents === 0) warnings.push("cognitive_trace_missing");
	if (retrievalEvents > 0 && decisionEvents === 0) {
		warnings.push("retrieval_without_decision");
	}
	if (decisionEvents > 0 && retrievalEvents === 0) {
		warnings.push("decision_without_retrieval");
	}
	if (retrievalEvents > 0 && decisionEvents > 0 && !hasRetrievalDecisionJoin) {
		warnings.push("retrieval_decision_fact_join_missing");
	}

	const status: TraceEvidenceSummary["status"] = hasRetrievalDecisionJoin
		? "retrieval_decision_linked"
		: cognitiveEvents > 0
			? "cognitive_linked"
			: "runtime_linked";

	return {
		status,
		mcpEvents: 0,
		runtimeEvents: rows.length,
		cognitiveEvents,
		retrievalEvents,
		decisionEvents,
		retrievedFactCount: retrievedFactIds.size,
		citedFactCount: citedFactIds.size,
		ignoredFactCount: ignoredFactIds.size,
		runtimeBackends: Array.from(runtimeBackends).sort(),
		hasRetrievalDecisionJoin,
		latestRuntimeAt,
		latestCognitiveAt,
		latestRetrievalAt,
		latestDecisionAt,
		cloudflare: emptyCloudflareTraceEvidence(),
		cognition,
		warnings,
	};
}

function recomputeTraceEvidenceStatus(
	summary: TraceEvidenceSummary,
	citedFactCount: number,
	ignoredFactCount: number,
): TraceEvidenceSummary["status"] {
	const hasRetrievalDecisionJoin =
		summary.retrievalEvents > 0 &&
		summary.decisionEvents > 0 &&
		(citedFactCount > 0 || ignoredFactCount > 0);
	if (hasRetrievalDecisionJoin) return "retrieval_decision_linked";
	if (summary.cognitiveEvents > 0) return "cognitive_linked";
	if (summary.runtimeEvents > 0) return "runtime_linked";
	return summary.status;
}

function removeWarnings(warnings: string[], remove: Set<string>): string[] {
	return warnings.filter((warning) => !remove.has(warning));
}

function latestRationaleRecord(
	records: DurableRationaleEvidenceRow[],
): DurableRationaleEvidenceRow | null {
	let latest: DurableRationaleEvidenceRow | null = null;
	let latestMs: number | null = null;
	for (const record of records) {
		const ms = timestampMs(record.completedAt ?? record.createdAt);
		if (ms == null) continue;
		if (latestMs == null || ms >= latestMs) {
			latest = record;
			latestMs = ms;
		}
	}
	return latest;
}

export function applyDurableCognitionEvidence(
	summary: TraceEvidenceSummary,
	records: DurableRationaleEvidenceRow[],
): TraceEvidenceSummary {
	if (records.length === 0) return summary;

	const retrievedFactIds = new Set(summary.cognition.retrievedFactIds);
	const citedFactIds = new Set(summary.cognition.citedFactIds);
	const ignoredFactIds = new Set(summary.cognition.ignoredFactIds);
	const decisionIds = new Set(summary.cognition.decisionIds);

	for (const record of records) {
		decisionIds.add(record.id);
		for (const factId of extractFactIdsFromEvidence(record.evidence)) {
			citedFactIds.add(factId);
		}
	}

	if (retrievedFactIds.size > 0 && citedFactIds.size > 0) {
		for (const factId of retrievedFactIds) {
			if (!citedFactIds.has(factId)) ignoredFactIds.add(factId);
		}
	}

	const latestRecord = latestRationaleRecord(records);
	const latestDecision = latestRecord
		? {
				id: latestRecord.id,
				category: latestRecord.category,
				outcomeStatus: latestRecord.outcomeStatus,
				confidence: latestRecord.confidence,
				createdAt: latestRecord.createdAt,
				completedAt: latestRecord.completedAt,
				source: "rationale_record" as const,
			}
		: summary.cognition.latestDecision;
	const graph =
		summary.cognition.graph.status === "observed"
			? summary.cognition.graph
			: {
					status:
						decisionIds.size > 0
							? ("not_observed" as const)
							: ("not_applicable" as const),
					projectedDecisionIds: summary.cognition.graph.projectedDecisionIds,
					warnings:
						decisionIds.size > 0 ? ["graph_projection_not_observed"] : [],
				};
	const cognitionWarnings = removeWarnings(
		summary.cognition.warnings,
		new Set(["graph_projection_not_observed"]),
	);
	for (const warning of graph.warnings) cognitionWarnings.push(warning);
	const uniqueCognitionWarnings = Array.from(new Set(cognitionWarnings));
	const status = recomputeTraceEvidenceStatus(
		summary,
		citedFactIds.size,
		ignoredFactIds.size,
	);
	const warnings = removeWarnings(
		summary.warnings,
		new Set(["retrieval_decision_fact_join_missing"]),
	);
	if (
		summary.retrievalEvents > 0 &&
		summary.decisionEvents > 0 &&
		status !== "retrieval_decision_linked"
	) {
		warnings.push("retrieval_decision_fact_join_missing");
	}

	const cognition: CognitionEvidenceBundle = {
		...summary.cognition,
		summary: buildCognitionSummary({
			retrievedFactCount: retrievedFactIds.size,
			citedFactCount: citedFactIds.size,
			ignoredFactCount: ignoredFactIds.size,
			decisionCount: summary.decisionEvents,
			latestDecision,
			graph,
		}),
		retrievedFactIds: sortedValues(retrievedFactIds),
		citedFactIds: sortedValues(citedFactIds),
		ignoredFactIds: sortedValues(ignoredFactIds),
		decisionIds: sortedValues(decisionIds),
		latestDecision,
		graph,
		warnings: uniqueCognitionWarnings,
	};

	return {
		...summary,
		status,
		retrievedFactCount: retrievedFactIds.size,
		citedFactCount: citedFactIds.size,
		ignoredFactCount: ignoredFactIds.size,
		hasRetrievalDecisionJoin: status === "retrieval_decision_linked",
		cognition,
		warnings: Array.from(new Set(warnings)),
	};
}

export function applyCloudflareTraceEvidence(
	summary: TraceEvidenceSummary,
	evidence: CloudflareTraceEvidence | undefined,
): TraceEvidenceSummary {
	if (!evidence) return summary;
	return {
		...summary,
		cloudflare: {
			sampled: true,
			traceId: evidence.cloudflareTraceId,
			spanCount: evidence.spanCount,
			serviceNames: evidence.serviceNames,
			durationMs: evidence.durationMs,
			errorCount: evidence.errorCount,
			traceStartAt: evidence.traceStartAt,
			traceEndAt: evidence.traceEndAt,
		},
	};
}

export async function loadTraceEvidenceSummaries(
	context: BaseContext,
	organizationId: string | undefined,
	traceIds: string[],
	fromMs: number,
	toMs: number,
): Promise<Map<string, TraceEvidenceSummary>> {
	const uniqueTraceIds = uniqueStrings(traceIds).slice(0, 100);
	if (!organizationId || uniqueTraceIds.length === 0) return new Map();
	const rows = await listAnalyticsRuntimeTraceEvidence(context.db, {
		organizationId,
		traceIds: uniqueTraceIds,
		limit: 2000,
	});
	const byTrace = new Map<string, RuntimeTraceEvidenceRow[]>();
	for (const row of rows) {
		if (!row.traceId) continue;
		byTrace.set(row.traceId, [...(byTrace.get(row.traceId) ?? []), row]);
	}
	const summaries = new Map<string, TraceEvidenceSummary>();
	for (const traceId of uniqueTraceIds) {
		summaries.set(
			traceId,
			buildTraceEvidenceSummary(traceId, byTrace.get(traceId) ?? []),
		);
	}
	const decisionIds = uniqueStrings(
		Array.from(summaries.values()).flatMap(
			(summary) => summary.cognition.decisionIds,
		),
	).slice(0, 200);
	if (decisionIds.length > 0) {
		const rationaleRows = await listAnalyticsRationaleEvidence(context.db, {
			organizationId,
			decisionIds,
		});
		const rationaleRowsById = new Map(
			rationaleRows.map((row) => [row.id, row as DurableRationaleEvidenceRow]),
		);
		for (const [traceId, summary] of summaries.entries()) {
			const durableRecords = summary.cognition.decisionIds
				.map((decisionId) => rationaleRowsById.get(decisionId))
				.filter((row): row is DurableRationaleEvidenceRow => !!row);
			if (durableRecords.length > 0) {
				summaries.set(
					traceId,
					applyDurableCognitionEvidence(summary, durableRecords),
				);
			}
		}
	}

	if (hasWorkersObservabilityConfig(context.env)) {
		try {
			const cloudflareEvidence = await queryWorkersTraceEvidence(context.env, {
				fromMs: fromMs - ACTIVITY_REVIEW_TRACE_FRESHNESS_MAX_LAG_MS,
				toMs: toMs + ACTIVITY_REVIEW_TRACE_FRESHNESS_MAX_LAG_MS,
				traceIds: uniqueTraceIds,
			});
			for (const [traceId, summary] of summaries.entries()) {
				summaries.set(
					traceId,
					applyCloudflareTraceEvidence(
						summary,
						cloudflareEvidence.get(traceId),
					),
				);
			}
		} catch (error) {
			console.error("[Analytics] Workers trace evidence join failed:", error);
		}
	}
	return summaries;
}

export function buildTraceEvidenceCoverage(
	groups: Pick<ActivityReviewGroup, "traceEvidence">[],
): TraceEvidenceCoverage {
	const totalGroups = groups.length;
	const auditOnlyGroups = groups.filter(
		(group) => group.traceEvidence.status === "audit_only",
	).length;
	const runtimeLinkedGroups = groups.filter(
		(group) => group.traceEvidence.status === "runtime_linked",
	).length;
	const mcpLinkedGroups = groups.filter(
		(group) => group.traceEvidence.status === "mcp_linked",
	).length;
	const cognitiveLinkedGroups = groups.filter(
		(group) => group.traceEvidence.status === "cognitive_linked",
	).length;
	const retrievalDecisionLinkedGroups = groups.filter(
		(group) => group.traceEvidence.status === "retrieval_decision_linked",
	).length;
	const missingTraceGroups = groups.filter(
		(group) => group.traceEvidence.status === "missing_trace",
	).length;
	const proofLinkedGroups =
		mcpLinkedGroups +
		runtimeLinkedGroups +
		cognitiveLinkedGroups +
		retrievalDecisionLinkedGroups;
	const proofCoverageRate =
		totalGroups > 0 ? proofLinkedGroups / totalGroups : 0;
	const warnings = Array.from(
		new Set(groups.flatMap((group) => group.traceEvidence.warnings)),
	);
	const status: TraceEvidenceCoverage["status"] =
		totalGroups === 0
			? "no_data"
			: proofCoverageRate >= ACTIVITY_REVIEW_TRACE_PROOF_TARGET
				? "met"
				: proofCoverageRate >= ACTIVITY_REVIEW_TRACE_PROOF_TARGET / 2
					? "warning"
					: "breach";

	return {
		status,
		targetCoverageRate: ACTIVITY_REVIEW_TRACE_PROOF_TARGET,
		proofCoverageRate,
		proofLinkedGroups,
		auditOnlyGroups,
		mcpLinkedGroups,
		runtimeLinkedGroups,
		cognitiveLinkedGroups,
		retrievalDecisionLinkedGroups,
		missingTraceGroups,
		warnings,
	};
}

function latestProofTimestamp(
	group: Pick<ActivityReviewGroup, "endedAt" | "traceEvidence">,
): string | null {
	switch (group.traceEvidence.status) {
		case "mcp_linked":
			return group.endedAt;
		case "runtime_linked":
			return group.traceEvidence.latestRuntimeAt;
		case "cognitive_linked":
			return (
				group.traceEvidence.latestCognitiveAt ??
				group.traceEvidence.latestRuntimeAt
			);
		case "retrieval_decision_linked":
			return (
				group.traceEvidence.latestDecisionAt ??
				group.traceEvidence.latestRetrievalAt ??
				group.traceEvidence.latestCognitiveAt ??
				group.traceEvidence.latestRuntimeAt
			);
		case "audit_only":
		case "missing_trace":
			return null;
	}
}

export function buildTraceFreshnessCoverage(
	groups: Pick<ActivityReviewGroup, "endedAt" | "traceEvidence">[],
): TraceFreshnessCoverage {
	const proofGroups = groups.filter(
		(group) =>
			group.traceEvidence.status !== "audit_only" &&
			group.traceEvidence.status !== "missing_trace",
	);
	let freshGroups = 0;
	let staleGroups = 0;
	let missingProofTimestampGroups = 0;
	let maxLagMs: number | null = null;
	let latestAuditAt: string | null = null;
	let latestProofAt: string | null = null;

	for (const group of proofGroups) {
		latestAuditAt = latestIso(latestAuditAt, group.endedAt);
		const proofAt = latestProofTimestamp(group);
		latestProofAt = latestIso(latestProofAt, proofAt);
		const auditMs = timestampMs(group.endedAt);
		const proofMs = timestampMs(proofAt);
		if (auditMs == null || proofMs == null) {
			missingProofTimestampGroups += 1;
			continue;
		}
		const lagMs = Math.abs(auditMs - proofMs);
		maxLagMs = maxLagMs == null ? lagMs : Math.max(maxLagMs, lagMs);
		if (lagMs <= ACTIVITY_REVIEW_TRACE_FRESHNESS_MAX_LAG_MS) {
			freshGroups += 1;
		} else {
			staleGroups += 1;
		}
	}

	const freshnessRate =
		proofGroups.length > 0 ? freshGroups / proofGroups.length : 0;
	const warnings = [
		...(staleGroups > 0 ? ["trace_proof_stale"] : []),
		...(missingProofTimestampGroups > 0
			? ["trace_proof_timestamp_missing"]
			: []),
	];
	const status: TraceFreshnessCoverage["status"] =
		proofGroups.length === 0
			? "no_data"
			: freshnessRate >= ACTIVITY_REVIEW_TRACE_FRESHNESS_TARGET
				? "met"
				: freshnessRate >= ACTIVITY_REVIEW_TRACE_FRESHNESS_TARGET / 2
					? "warning"
					: "breach";

	return {
		status,
		targetMaxLagMs: ACTIVITY_REVIEW_TRACE_FRESHNESS_MAX_LAG_MS,
		freshnessRate,
		proofGroups: proofGroups.length,
		freshGroups,
		staleGroups,
		missingProofTimestampGroups,
		maxLagMs,
		latestAuditAt,
		latestProofAt,
		warnings,
	};
}
