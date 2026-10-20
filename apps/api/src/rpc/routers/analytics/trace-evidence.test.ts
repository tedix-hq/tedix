import { describe, expect, it } from "vite-plus/test";
import {
	markMcpTraceEvidence,
	buildTraceEvidenceSummary,
	applyDurableCognitionEvidence,
	applyCloudflareTraceEvidence,
	buildTraceEvidenceCoverage,
	buildTraceFreshnessCoverage,
} from "./trace-evidence";

function emptyCognitionEvidence() {
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

function emptyCloudflareTraceEvidence() {
	return {
		sampled: false,
		traceId: null,
		spanCount: 0,
		serviceNames: [],
		durationMs: null,
		errorCount: 0,
		traceStartAt: null,
		traceEndAt: null,
	};
}

describe("activity review trace evidence", () => {
	it("classifies retrieval and decision evidence joined inside one trace", () => {
		const result = buildTraceEvidenceSummary("trace-1", [
			{
				traceId: "trace-1",
				kind: "run.started",
				createdAt: "2026-06-10T12:00:00.000Z",
				runtimeBackend: "cloudflare-agents",
				payload: {},
			},
			{
				traceId: "trace-1",
				kind: "memory.retrieved",
				createdAt: "2026-06-10T12:01:00.000Z",
				runtimeBackend: "cloudflare-agents",
				payload: {
					factIds: ["fact-a", "fact-b"],
					topK: 5,
					returnedCount: 2,
					vectorEnabled: true,
					vectorMs: 11,
					hydrateFactsMs: 7,
				},
			},
			{
				traceId: "trace-1",
				kind: "decision.recorded",
				createdAt: "2026-06-10T12:02:00.000Z",
				runtimeBackend: "cloudflare-agents",
				payload: {
					rationaleRecordId: "decision-1",
					category: "operations",
					outcomeStatus: "success",
					confidence: 0.82,
					citedFactIds: ["fact-a"],
					ignoredFactIds: ["fact-b"],
				},
			},
		]);

		expect(result).toEqual({
			status: "retrieval_decision_linked",
			mcpEvents: 0,
			runtimeEvents: 3,
			cognitiveEvents: 2,
			retrievalEvents: 1,
			decisionEvents: 1,
			retrievedFactCount: 2,
			citedFactCount: 1,
			ignoredFactCount: 1,
			runtimeBackends: ["cloudflare-agents"],
			hasRetrievalDecisionJoin: true,
			latestRuntimeAt: "2026-06-10T12:02:00.000Z",
			latestCognitiveAt: "2026-06-10T12:02:00.000Z",
			latestRetrievalAt: "2026-06-10T12:01:00.000Z",
			latestDecisionAt: "2026-06-10T12:02:00.000Z",
			cloudflare: emptyCloudflareTraceEvidence(),
			cognition: {
				summary:
					"2 fact(s) retrieved; 1 cited / 1 ignored; 1 decision event(s), success; graph projection not observed",
				retrievedFactIds: ["fact-a", "fact-b"],
				citedFactIds: ["fact-a"],
				ignoredFactIds: ["fact-b"],
				decisionIds: ["decision-1"],
				latestDecision: {
					id: "decision-1",
					category: "operations",
					outcomeStatus: "success",
					confidence: 0.82,
					createdAt: "2026-06-10T12:02:00.000Z",
					completedAt: null,
					source: "runtime",
				},
				retrieval: {
					topK: 5,
					returnedCount: 2,
					vectorEnabled: true,
					vectorMs: 11,
					hydrateFactsMs: 7,
				},
				graph: {
					status: "not_observed",
					projectedDecisionIds: [],
					warnings: ["graph_projection_not_observed"],
				},
				warnings: ["graph_projection_not_observed"],
			},
			warnings: [],
		});
	});

	it("adds sampled Cloudflare trace evidence without changing cognitive proof", () => {
		const result = applyCloudflareTraceEvidence(
			buildTraceEvidenceSummary("trace-1", []),
			{
				cloudflareTraceId: "cf-trace-1",
				durationMs: 42,
				errorCount: 0,
				serviceNames: ["tedix-mcp-production"],
				spanCount: 7,
				traceEndAt: "2026-06-10T12:00:00.042Z",
				traceStartAt: "2026-06-10T12:00:00.000Z",
			},
		);

		expect(result.status).toBe("audit_only");
		expect(result.cloudflare).toEqual({
			sampled: true,
			traceId: "cf-trace-1",
			spanCount: 7,
			serviceNames: ["tedix-mcp-production"],
			durationMs: 42,
			errorCount: 0,
			traceStartAt: "2026-06-10T12:00:00.000Z",
			traceEndAt: "2026-06-10T12:00:00.042Z",
		});
	});

	it("hydrates cognition evidence from durable rationale records", () => {
		const result = applyDurableCognitionEvidence(
			buildTraceEvidenceSummary("trace-1", [
				{
					traceId: "trace-1",
					kind: "memory.retrieved",
					createdAt: "2026-06-10T12:01:00.000Z",
					runtimeBackend: "cloudflare-agents",
					payload: {
						factIds: ["fact-a", "fact-b"],
						topK: 5,
						returnedCount: 2,
						vectorEnabled: true,
						vectorMs: 11,
						hydrateFactsMs: 7,
					},
				},
				{
					traceId: "trace-1",
					kind: "decision.recorded",
					createdAt: "2026-06-10T12:02:00.000Z",
					runtimeBackend: "cloudflare-agents",
					payload: {
						rationaleRecordId: "decision-1",
						category: "operations",
						outcomeStatus: "pending",
						confidence: 0.72,
					},
				},
			]),
			[
				{
					id: "decision-1",
					category: "operations",
					outcomeStatus: "success",
					confidence: 0.91,
					createdAt: "2026-06-10T12:02:00.000Z",
					completedAt: "2026-06-10T12:04:00.000Z",
					evidence: {
						factIds: ["fact-a"],
					},
				},
			],
		);

		expect(result).toMatchObject({
			status: "retrieval_decision_linked",
			citedFactCount: 1,
			ignoredFactCount: 1,
			hasRetrievalDecisionJoin: true,
			cognition: {
				summary:
					"2 fact(s) retrieved; 1 cited / 1 ignored; 1 decision event(s), success; graph projection not observed",
				retrievedFactIds: ["fact-a", "fact-b"],
				citedFactIds: ["fact-a"],
				ignoredFactIds: ["fact-b"],
				decisionIds: ["decision-1"],
				latestDecision: {
					id: "decision-1",
					category: "operations",
					outcomeStatus: "success",
					confidence: 0.91,
					createdAt: "2026-06-10T12:02:00.000Z",
					completedAt: "2026-06-10T12:04:00.000Z",
					source: "rationale_record",
				},
				warnings: ["graph_projection_not_observed"],
			},
			warnings: [],
		});
	});

	it("keeps audit-only traces explicit instead of implying cognitive proof", () => {
		expect(buildTraceEvidenceSummary("trace-2", [])).toEqual({
			status: "audit_only",
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
			warnings: ["runtime_trace_missing"],
		});
	});

	it("counts MCP audit events as trace proof without implying runtime proof", () => {
		expect(
			markMcpTraceEvidence(buildTraceEvidenceSummary("trace-2", []), 4),
		).toEqual({
			status: "mcp_linked",
			mcpEvents: 4,
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
			warnings: [],
		});
	});

	it("summarizes trace proof coverage against the review SLO", () => {
		const coverage = buildTraceEvidenceCoverage([
			{
				traceEvidence: markMcpTraceEvidence(
					buildTraceEvidenceSummary("trace-a", []),
					2,
				),
			},
			{
				traceEvidence: buildTraceEvidenceSummary("trace-b", [
					{
						traceId: "trace-b",
						kind: "run.started",
						createdAt: "2026-06-10T12:04:00.000Z",
						runtimeBackend: "cloudflare-agents",
						payload: {},
					},
				]),
			},
			{
				traceEvidence: buildTraceEvidenceSummary("trace-c", [
					{
						traceId: "trace-c",
						kind: "memory.retrieved",
						createdAt: "2026-06-10T12:05:00.000Z",
						runtimeBackend: "cloudflare-agents",
						payload: { factIds: ["fact-a"] },
					},
					{
						traceId: "trace-c",
						kind: "decision.completed",
						createdAt: "2026-06-10T12:05:10.000Z",
						runtimeBackend: "cloudflare-agents",
						payload: { citedFactIds: ["fact-a"] },
					},
				]),
			},
		]);

		expect(coverage).toEqual({
			status: "met",
			targetCoverageRate: 0.8,
			proofCoverageRate: 1,
			proofLinkedGroups: 3,
			auditOnlyGroups: 0,
			mcpLinkedGroups: 1,
			runtimeLinkedGroups: 1,
			cognitiveLinkedGroups: 0,
			retrievalDecisionLinkedGroups: 1,
			missingTraceGroups: 0,
			warnings: ["cognitive_trace_missing"],
		});
	});

	it("marks empty trace proof coverage as no-data", () => {
		expect(buildTraceEvidenceCoverage([])).toEqual({
			status: "no_data",
			targetCoverageRate: 0.8,
			proofCoverageRate: 0,
			proofLinkedGroups: 0,
			auditOnlyGroups: 0,
			mcpLinkedGroups: 0,
			runtimeLinkedGroups: 0,
			cognitiveLinkedGroups: 0,
			retrievalDecisionLinkedGroups: 0,
			missingTraceGroups: 0,
			warnings: [],
		});
	});

	it("summarizes trace proof freshness against the review SLO", () => {
		const coverage = buildTraceFreshnessCoverage([
			{
				endedAt: "2026-06-10T12:00:00.000Z",
				traceEvidence: markMcpTraceEvidence(
					buildTraceEvidenceSummary("trace-a", []),
					2,
				),
			},
			{
				endedAt: "2026-06-10T12:10:00.000Z",
				traceEvidence: buildTraceEvidenceSummary("trace-b", [
					{
						traceId: "trace-b",
						kind: "run.started",
						createdAt: "2026-06-10T12:12:00.000Z",
						runtimeBackend: "cloudflare-agents",
						payload: {},
					},
				]),
			},
			{
				endedAt: "2026-06-10T12:20:00.000Z",
				traceEvidence: buildTraceEvidenceSummary("trace-c", [
					{
						traceId: "trace-c",
						kind: "memory.retrieved",
						createdAt: "2026-06-10T12:34:00.000Z",
						runtimeBackend: "cloudflare-agents",
						payload: { factIds: ["fact-a"] },
					},
					{
						traceId: "trace-c",
						kind: "decision.completed",
						createdAt: "2026-06-10T12:35:00.000Z",
						runtimeBackend: "cloudflare-agents",
						payload: { citedFactIds: ["fact-a"] },
					},
				]),
			},
			{
				endedAt: "2026-06-10T12:40:00.000Z",
				traceEvidence: buildTraceEvidenceSummary("trace-d", []),
			},
		]);

		expect(coverage).toEqual({
			status: "warning",
			targetMaxLagMs: 300000,
			freshnessRate: 2 / 3,
			proofGroups: 3,
			freshGroups: 2,
			staleGroups: 1,
			missingProofTimestampGroups: 0,
			maxLagMs: 900000,
			latestAuditAt: "2026-06-10T12:20:00.000Z",
			latestProofAt: "2026-06-10T12:35:00.000Z",
			warnings: ["trace_proof_stale"],
		});
	});

	it("marks empty trace freshness coverage as no-data", () => {
		expect(buildTraceFreshnessCoverage([])).toEqual({
			status: "no_data",
			targetMaxLagMs: 300000,
			freshnessRate: 0,
			proofGroups: 0,
			freshGroups: 0,
			staleGroups: 0,
			missingProofTimestampGroups: 0,
			maxLagMs: null,
			latestAuditAt: null,
			latestProofAt: null,
			warnings: [],
		});
	});
});
