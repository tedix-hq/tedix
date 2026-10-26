import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { billingProviderCostEvidenceVersions } from "../../schema/billing";
import { tediRuntimeEvents } from "../../schema/cognitive-runtime";
import {
	decisionExposures,
	decisionOutcomeLabels,
	learningInteractionEvents,
} from "../../schema/learning-feedback";
import { providerExecutionAttempts } from "../../schema/provider-executions";
import { tediCallCosts } from "../../schema/tedis";
import { workAdmissions } from "../../schema/work-factory";
import { workAttempts, workItems } from "../../schema/work-items";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { getModelFitReport } from "./model-fit-report";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		schemaDdl(
			workItems,
			workAdmissions,
			workAttempts,
			providerExecutionAttempts,
			tediCallCosts,
			billingProviderCostEvidenceVersions,
			tediRuntimeEvents,
			learningInteractionEvents,
			decisionExposures,
			decisionOutcomeLabels,
		),
	);
	return { sqlite, db: createDbQueryClient(createD1Facade(sqlite)) };
}

describe("model fit report", () => {
	it("joins exact admitted task versions to route, usage, latency, retries and human corrections", async () => {
		const { db, sqlite } = fixture();
		try {
			await db.insert(workItems).values({
				id: "work",
				orgId: "org",
				title: "Fictional model fit",
				disposition: "accepted",
				createdAt: "2026-10-20T00:00:00.000Z",
				version: 4,
			});
			await db.insert(workAdmissions).values({
				id: "admission",
				orgId: "org",
				workItemId: "work",
				workItemVersion: 3,
				admissionSpecRevision: "fixture",
				executorType: "tedi",
				executorId: "tedi",
				decision: "admitted",
				decidedAt: "2026-10-20T00:00:00.000Z",
				expiresAt: "2026-10-21T00:00:00.000Z",
				createdAt: "2026-10-20T00:00:00.000Z",
			});
			await db.insert(workAttempts).values({
				id: "attempt",
				admissionId: "admission",
				workItemId: "work",
				orgId: "org",
				executorType: "tedi",
				executorId: "tedi",
				runId: "run",
				attemptNumber: 1,
				startedAt: "2026-10-20T00:00:00.000Z",
				heartbeatAt: "2026-10-20T00:00:01.000Z",
			});
			await db.insert(providerExecutionAttempts).values({
				id: "execution",
				organizationId: "org",
				tediId: "tedi",
				source: "runtime",
				runId: "run",
				workItemId: "work",
				idempotencyKey: "execution-key",
				settlementMode: "external",
				provider: "workers-ai",
				requestModel: "cloudflare/auto",
				gatewayAccountId: "fictional-account",
				gatewayId: "fictional-gateway",
				transportKind: "gateway-https",
				apiKind: "workers-ai-chat",
				deploymentScope: "fictional-scope",
				authorizedAt: "2026-10-20T00:00:00.000Z",
				sendBefore: "2026-10-20T00:01:00.000Z",
				origin: { inputDigest: "sha256:fixture" },
				policy: { purpose: "fixture" },
			});
			await db.insert(tediCallCosts).values([
				{
					id: "call-1",
					orgId: "org",
					tediId: "tedi",
					gatewayLogId: "log-1",
					gatewayId: "fictional-gateway",
					snapshotAt: "2026-10-20T00:00:02.000Z",
					model: "@cf/fictional/initial",
					provider: "workers-ai",
					runId: "run",
					workItemId: "work",
					executionId: "execution",
					sessionType: "tedi",
					source: "runtime",
					inputTokens: 800,
					outputTokens: 100,
					cacheReadTokens: 100,
					totalTokens: 1000,
					estimatedCostUsd: 0.02,
					costBasis: "governed_estimate",
					dataQuality: "ok",
					callDurationMs: 2000,
					sessionCount: 1,
				},
				{
					id: "call-2",
					orgId: "org",
					tediId: "tedi",
					gatewayLogId: "log-2",
					gatewayId: "fictional-gateway",
					snapshotAt: "2026-10-20T00:00:08.000Z",
					model: "fallback",
					provider: "workers-ai",
					runId: "run",
					workItemId: "work",
					sessionType: "tedi",
					source: "runtime",
					inputTokens: 400,
					outputTokens: 100,
					totalTokens: 500,
					costBasis: "unknown",
					dataQuality: "quarantined_no_pricing",
					callDurationMs: 9000,
					sessionCount: 1,
				},
				{
					id: "call-unknown",
					orgId: "org",
					gatewayLogId: "log-unknown",
					gatewayId: "fictional-gateway",
					snapshotAt: "2026-10-20T00:00:09.000Z",
					model: "unattributed-model",
					provider: "workers-ai",
					workItemId: "work",
					sessionType: "unattributed",
					source: "gateway",
					totalTokens: 0,
					costBasis: "unknown",
					dataQuality: "quarantined_no_pricing",
				},
			]);
			await db.insert(tediCallCosts).values([
				{
					id: "call-unmatched-run",
					orgId: "org",
					gatewayLogId: "log-unmatched-run",
					gatewayId: "fictional-gateway",
					snapshotAt: "2026-10-20T00:00:09.500Z",
					model: "unmatched-model",
					provider: "workers-ai",
					runId: "unmatched-run",
					workItemId: "work",
					sessionType: "unattributed",
					source: "gateway",
					totalTokens: 0,
					costBasis: "unknown",
					dataQuality: "quarantined_no_pricing",
				},
				{
					id: "other-tenant-call",
					orgId: "other",
					gatewayLogId: "other-tenant-log",
					gatewayId: "fictional-gateway",
					snapshotAt: "2026-10-20T00:00:10.000Z",
					model: "other-model",
					workItemId: "work",
					sessionType: "unattributed",
					source: "gateway",
					costBasis: "unknown",
					dataQuality: "quarantined_no_pricing",
				},
			]);
			const digest = "a".repeat(64);
			await db.insert(billingProviderCostEvidenceVersions).values({
				id: "reviewed-cost",
				originalOrgId: "org",
				sourceGatewayId: "fictional-gateway",
				gatewayLogId: "log-1",
				sourceCallId: "call-1",
				scopeDigest: digest,
				originalSourceDigest: digest,
				occurredAt: "2026-10-20T00:00:02.000Z",
				recordedAt: "2026-10-20T02:00:00.000Z",
				provider: "workers-ai",
				nativeModel: "@cf/fictional/initial",
				nativeFactsReceiptDigest: digest,
				basisFactsDigest: digest,
				financialManifestDigest: digest,
				financialWorkId: "financial-work",
				financialSpecRevision: "fixture",
				approvalProposalId: "proposal",
				approvalDecisionId: "decision",
				attemptId: "financial-attempt",
				admissionId: "financial-admission",
				createdByActorType: "external_agent",
				createdByActorId: "reviewer",
				createdBySessionId: "review-session",
				idempotencyDigest: digest,
				payloadDigest: digest,
				originalSourceSnapshot: {},
				deploymentScope: {},
				reportedCostDecimal: "0.03",
				reportedReporter: "cloudflare_ai_gateway",
				reportedEstimateSnapshot: {},
				financialManifestSnapshot: {},
				approvalDecisionSnapshot: {},
				originalSourceVersion: 1,
				inputTokens: 800,
				outputTokens: 100,
				cacheReadTokens: 100,
				cacheWriteTokens: 0,
				providerEstimatedCostMicros: 30_000,
				financialWorkVersion: 1,
				nativeUsageKnown: true,
				kind: "provider_estimate",
				currency: "USD",
				pricingBasis: "reported_estimate",
			});
			const fallback = {
				operation: "model_fallback",
				from: "cloudflare/auto",
				to: "workers-ai/fallback",
				reason: "provider_unavailable",
				ordinal: 1,
				policyVersion: 1,
			};
			await db.insert(tediRuntimeEvents).values([
				{
					id: "retry",
					organizationId: "org",
					tediId: "tedi",
					kind: "step.retry",
					runId: "run",
					payload: fallback,
					runtimeBackend: "cloudflare-agents",
				},
				{
					id: "other-tenant-retry",
					organizationId: "other",
					tediId: "tedi",
					kind: "step.retry",
					runId: "run",
					payload: { ...fallback, ordinal: 2 },
					runtimeBackend: "cloudflare-agents",
				},
			]);
			await db.insert(learningInteractionEvents).values([
				{
					id: "edit",
					organizationId: "org",
					actorType: "user",
					actorId: "user",
					clientEventId: "edit",
					eventKind: "edited",
					scopeKind: "personal",
					scopeId: "user",
					surface: "decision_learning",
					targetType: "work_item",
					targetId: "work",
					occurredAt: "2026-10-20T01:00:00.000Z",
				},
				{
					id: "not-human",
					organizationId: "org",
					actorType: "service",
					clientEventId: "not-human",
					eventKind: "edited",
					scopeKind: "organization",
					scopeId: "org",
					surface: "decision_learning",
					targetType: "work_item",
					targetId: "work",
					occurredAt: "2026-10-20T01:00:00.000Z",
				},
				{
					id: "other-tenant-edit",
					organizationId: "other",
					actorType: "user",
					actorId: "user",
					clientEventId: "other-tenant-edit",
					eventKind: "edited",
					scopeKind: "personal",
					scopeId: "user",
					surface: "decision_learning",
					targetType: "work_item",
					targetId: "work",
					occurredAt: "2026-10-20T01:00:00.000Z",
				},
				{
					id: "colliding-target-edit",
					organizationId: "org",
					actorType: "user",
					actorId: "user",
					clientEventId: "colliding-target-edit",
					eventKind: "edited",
					scopeKind: "personal",
					scopeId: "user",
					surface: "decision_learning",
					targetType: "output",
					targetId: "work",
					occurredAt: "2026-10-20T01:00:00.000Z",
				},
			]);
			await db.insert(decisionExposures).values({
				id: "exposure",
				organizationId: "org",
				actorId: "user",
				cardId: "card",
				sessionId: "session",
				classId: "review",
				snapshot: {
					classId: "review",
					projectId: null,
					workItemId: "work",
					kind: "review",
					title: "Review",
					body: null,
					options: [],
					recommendation: null,
					confidence: null,
					proposerId: null,
					stakes: {
						reversibility: null,
						blastRadius: null,
						protectedEffects: [],
					},
					urgency: { whyNow: null, costOfWaiting: null, dueAt: null },
					prediction: {
						unchangedApprovalLikelihood: null,
						modelVersion: null,
					},
				},
				context: {
					clientEventId: "11111111-1111-4111-8111-111111111111",
					sessionId: "22222222-2222-4222-8222-222222222222",
					cardId: "card",
					sourceVersion: 1,
					position: 0,
					aboveFold: ["title"],
					railOpened: false,
					timezone: "UTC",
					candidateCount: 1,
					candidates: [],
					candidateSetComplete: false,
					rankingEvidenceTruncated: false,
					selectionPolicy: "deterministic_current_order",
					selectionProbability: null,
				},
				occurredAt: "2026-10-20T00:30:00.000Z",
				expiresAt: "2027-01-20T00:30:00.000Z",
			});
			await db.insert(decisionOutcomeLabels).values({
				id: "label",
				organizationId: "org",
				actorId: "user",
				cardId: "card",
				classId: "review",
				window: "immediate",
				outcome: {
					evidenceSource: "canonical_receipt",
					label: "edited_then_approved",
					reason: null,
					exposureId: "exposure",
					receiptId: "receipt",
					decidedAt: "2026-10-20T01:00:00.000Z",
					laterToDecisionMs: null,
				},
				observedAt: "2026-10-20T01:00:00.000Z",
				dueAt: "2026-10-20T01:00:00.000Z",
				expiresAt: "2027-01-20T00:30:00.000Z",
			});

			const report = await getModelFitReport(db, {
				organizationId: "org",
				workItemId: "work",
			});
			expect(report).toMatchObject({
				task: { workItemId: "work", currentVersion: 4 },
				latency: {
					p50Ms: 2000,
					p95Ms: 9000,
					coverage: { known: 2, total: 4 },
					providerDurationP50Ms: null,
				},
				cost: {
					knownSubtotalUsd: 0.03,
					knownCostPer1kTokensUsd: 0.03,
					knownTokens: 1000,
					coverage: { known: 1, total: 4 },
				},
				retries: {
					initialAttemptDenominator: null,
					initialObservedRunDenominator: 2,
					observedFallbackTransitions: 1,
					runsWithFallback: 1,
					exhaustedFallbackDenominator: null,
				},
				human: {
					explicitCorrectionEvents: 1,
					attentionOutcomes: 1,
					editedAttentionOutcomes: 1,
					attentionOutcomeLabels: { edited_then_approved: 1 },
				},
				coverage: {
					taskVersion: { known: 2, total: 4 },
					providerExecution: { known: 1, total: 4 },
					retryLedger: { known: 2, total: 4 },
					errorKind: { known: 0, total: 4 },
					rawInput: { known: 0, total: 4 },
				},
			});
			expect(report?.calls[0]).toMatchObject({
				taskVersion: 3,
				requestedModel: "cloudflare/auto",
				actualModel: "@cf/fictional/initial",
				cacheReadTokens: 100,
				runFallbackTransitions: 1,
				errorKind: null,
			});
			expect(report?.routes).toContainEqual({
				provider: "workers-ai",
				model: "fallback",
				observedCalls: 1,
				initialObservedRuns: 0,
				fallbackTransitionsToRoute: 1,
			});
			expect(report?.calls[2]?.runFallbackTransitions).toBeNull();
			expect(report?.calls[3]?.runFallbackTransitions).toBeNull();
		} finally {
			sqlite.close();
		}
	});

	it("returns null for a task outside the tenant fence", async () => {
		const { db, sqlite } = fixture();
		try {
			expect(
				await getModelFitReport(db, {
					organizationId: "other",
					workItemId: "missing",
				}),
			).toBeNull();
		} finally {
			sqlite.close();
		}
	});
});
