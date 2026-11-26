import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { coreTable } from "../../core-store/client";
import { createDbClient, type DbClient } from "../../client";
import type { DbQueryClient } from "../../query-client";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import { createPGliteFacade } from "../../test/pglite-facade";
import { organizations } from "../../schema/organizations";
import { billingCostRollups } from "../../schema/billing-cost-rollups";
import { billingProviderCostEvidenceVersions } from "../../schema/billing";
import { tediCallCosts } from "../../schema/tedis";
import {
	applyDynamicWorkerCostAllocation,
	getDailyProviderUnitSpend,
	getWorkstationCostCoverage,
	recordBillingProviderUsage,
	recordBillingUsageQuarantines,
	sumDynamicWorkerAllocatedCost,
} from "./provider-usage";
import { listCostRollups, rebuildCostRollupDay } from "./cost-rollups";

const at = "2026-11-20T12:00:00.000Z";
const periodStart = "2026-09-01T00:00:00.000Z";
const periodEnd = "2026-10-01T00:00:00.000Z";

for (const store of ["d1", "postgres"] as const)
	describe(`lane 4 billing parity on ${store}`, () => {
		let db: DbClient;
		let query: DbQueryClient;
		let close: () => void | Promise<void>;
		beforeAll(async () => {
			if (store === "postgres") {
				const fixture = await createPGliteFacade();
				db = fixture.db;
				query = fixture.db;
				close = fixture.close;
				for (const migration of readMigrationFiles({
					migrationsFolder: fileURLToPath(
						new URL("../../../drizzle-pg", import.meta.url),
					),
				}))
					for (const ddl of migration.sql) await fixture.engine.exec(ddl);
			} else {
				const sqlite = createMigratedSqlite();
				const facade = createD1Facade(sqlite, { maxBoundParams: 100 });
				db = createDbClient(facade);
				query = createDbQueryClient(facade);
				close = () => {
					if (sqlite.isOpen) sqlite.close();
				};
			}
			await db.insert(coreTable(db, organizations)).values({
				id: "orchard",
				name: "Orchard",
				slug: "orchard",
			});
		}, 60000);
		afterAll(async () => {
			await close?.();
		});

		it("records provider usage once, quarantines in chunks and reports daily spend", async () => {
			const input = {
				id: "usage-1",
				organizationId: "orchard",
				provider: "cloudflare",
				model: "container:standard-1",
				usageKind: "voice_stt" as const,
				unit: "seconds" as const,
				quantity: 10,
				providerCostMicros: 500,
				providerCostQuality: "estimated" as const,
				occurredAt: "2026-11-20T08:00:00.000Z",
				gatewayLogId: "log-1",
				now: at,
			};
			const first = await recordBillingProviderUsage(db, input);
			const second = await recordBillingProviderUsage(db, {
				...input,
				id: "usage-duplicate",
			});
			expect(second.id).toBe(first.id);
			const quarantines = Array.from({ length: 12 }, (_, i) => ({
				gatewayLogId: `quarantine-${i}`,
				organizationId: "orchard",
				reason: "unpriced_usage" as const,
				sourceSnapshotAt: "2026-11-20T08:00:00.000Z",
				createdAt: at,
			}));
			expect(await recordBillingUsageQuarantines(db, quarantines)).toBe(12);
			expect(await recordBillingUsageQuarantines(db, quarantines)).toBe(0);
			const spend = await getDailyProviderUnitSpend(db, {
				usageKind: "voice_stt",
				organizationId: "orchard",
				now: at,
				lookbackDays: 1,
			});
			expect(spend).toMatchObject({
				dailyMicros: 500,
				dailyQuantity: 10,
				usageKind: "voice_stt",
			});
		});

		it("classifies workstation cost coverage identically on both stores", async () => {
			const evidence = {
				pricingStatus: "allocated",
				allocation: {
					basis: "workstation_lease_wall_clock_share",
					chargeSourceRef: "fictional-bill",
					chargePeriod: "2026-08-28T00:00:00.000Z..2026-09-28T00:00:00.000Z",
					chargeTotalMicros: 1000,
					shareBasisPoints: 5000,
				},
			};
			const base = {
				organizationId: "orchard",
				provider: "cloudflare",
				model: "container:standard-1",
				usageKind: "workstation_compute" as const,
				unit: "compute_seconds" as const,
				quantity: 10,
				providerCostMicros: 500,
				providerCostQuality: "provider_reconciled" as const,
				occurredAt: "2026-09-20T00:00:00.000Z",
				gatewayLogId: "coverage-1",
				now: at,
			};
			await recordBillingProviderUsage(db, {
				...base,
				id: "coverage-reconciled",
				metadata: evidence,
			});
			await recordBillingProviderUsage(db, {
				...base,
				id: "coverage-pending",
				gatewayLogId: "coverage-2",
				providerCostQuality: "estimated",
				providerCostMicros: 0,
				metadata: {},
			});
			await recordBillingProviderUsage(db, {
				...base,
				id: "coverage-unproven",
				gatewayLogId: "coverage-3",
				providerCostQuality: "gateway_reported",
				providerCostMicros: 700,
				metadata: { pricingStatus: "pending_allocation" },
			});
			const coverage = await getWorkstationCostCoverage(db, {
				organizationId: "orchard",
				periodStart,
				periodEnd,
			});
			expect(coverage).toMatchObject({
				status: "partial",
				knownAttributedCostMicros: 500,
				total: { rowCount: 3, leaseSeconds: 30 },
				reconciled: { rowCount: 1, leaseSeconds: 10 },
				pending: { rowCount: 1, leaseSeconds: 10 },
				unproven: { rowCount: 1, leaseSeconds: 10 },
			});
		});

		it("allocates anonymous worker cost and sums provider totals identically", async () => {
			for (const [id, quantity] of [
				["worker-a", 3],
				["worker-b", 2],
			] as const)
				await recordBillingProviderUsage(db, {
					id,
					organizationId: "orchard",
					provider: "cloudflare-dynamic-workers",
					model: "worker",
					usageKind: "other",
					unit: "units",
					quantity,
					providerCostMicros: 0,
					providerCostQuality: "estimated",
					occurredAt: "2026-09-15T00:00:00.000Z",
					gatewayLogId: id,
					now: at,
					metadata: { identity: "anonymous" },
				});
			await applyDynamicWorkerCostAllocation(db, {
				periodStart,
				periodEnd,
				totalCostMicros: 10000,
				billedQuantity: 10,
				evidenceRef: "fictional-invoice",
			});
			expect(
				await sumDynamicWorkerAllocatedCost(db, { periodStart, periodEnd }),
			).toEqual({ micros: 5000, rows: 2 });
		});

		it("rebuilds cost rollups and marks organization-days stale on call writes", async () => {
			const calls = coreTable(db, tediCallCosts);
			await db.insert(calls).values({
				id: "call-rollup-1",
				orgId: "orchard",
				gatewayId: "gateway",
				gatewayLogId: "log-rollup-1",
				snapshotAt: "2026-09-20T10:00:00.000Z",
				model: "native",
				provider: "azure-openai",
				inputTokens: 100,
				outputTokens: 5,
				totalTokens: 105,
				costBasis: "unknown",
				dataQuality: "ok",
			});
			await rebuildCostRollupDay(query, "orchard", "2026-09-20", {
				now: new Date("2026-09-25T00:00:00.000Z"),
			});
			const fresh = await listCostRollups(
				query,
				"orchard",
				"2026-09-20",
				"2026-09-20",
			);
			expect(fresh).toHaveLength(1);
			expect(fresh[0]).toMatchObject({
				day: "2026-09-20",
				callCount: 1,
				totalTokens: 105,
			});
			await db.insert(calls).values({
				id: "call-rollup-2",
				orgId: "orchard",
				gatewayId: "gateway",
				gatewayLogId: "log-rollup-2",
				snapshotAt: "2026-09-20T11:00:00.000Z",
				model: "native",
				provider: "azure-openai",
			});
			expect(
				await listCostRollups(query, "orchard", "2026-09-20", "2026-09-20"),
			).toEqual([]);
			const rollups = coreTable(db, billingCostRollups);
			const [stale] = await db
				.select({ stale: rollups.stale })
				.from(rollups)
				.where(eq(rollups.day, "2026-09-20"));
			expect(stale?.stale).toBe(true);
		});

		it("marks rollup days stale when provider cost evidence lands", async () => {
			const calls = coreTable(db, tediCallCosts);
			await db.insert(calls).values({
				id: "call-evidence",
				orgId: "orchard",
				gatewayId: "gateway",
				gatewayLogId: "log-evidence",
				snapshotAt: "2026-10-07T00:00:00Z",
				model: "native",
				provider: "azure-openai",
				inputTokens: 100,
				outputTokens: 5,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				totalTokens: 105,
				costBasis: "unknown",
				dataQuality: "quarantined_no_pricing",
				success: true,
				cached: false,
				sessionType: "tedi",
				sessionCount: 1,
				source: "ai-gateway-log",
			});
			await rebuildCostRollupDay(query, "orchard", "2026-10-07", {
				now: new Date("2026-10-10T00:00:00.000Z"),
			});
			expect(
				await listCostRollups(query, "orchard", "2026-10-07", "2026-10-07"),
			).toHaveLength(1);
			const evidence = coreTable(db, billingProviderCostEvidenceVersions);
			await db.insert(evidence).values({
				id: "evidence-1",
				originalOrgId: "orchard",
				sourceGatewayId: "gateway",
				gatewayLogId: "log-evidence",
				sourceCallId: "call-evidence",
				scopeDigest: "a".repeat(64),
				originalSourceDigest: "b".repeat(64),
				occurredAt: "2026-10-07T00:00:00Z",
				recordedAt: "2026-10-07T01:00:00Z",
				provider: "azure-openai",
				nativeModel: "native",
				nativeFactsReceiptDigest: "c".repeat(64),
				basisFactsDigest: "d".repeat(64),
				financialManifestDigest: "e".repeat(64),
				financialWorkId: "financial",
				financialSpecRevision: "spec",
				approvalProposalId: "approval",
				approvalDecisionId: "decision",
				attemptId: "attempt",
				admissionId: "admission",
				createdByActorType: "external_agent",
				createdByActorId: "actor",
				createdBySessionId: "session",
				idempotencyDigest: "f".repeat(64),
				payloadDigest: "1".repeat(64),
				originalTediId: "tedi",
				originalSourceSnapshot: {
					id: "call-evidence",
					orgId: "orchard",
					gatewayId: "gateway",
					gatewayLogId: "log-evidence",
					tediId: "tedi",
					snapshotAt: "2026-10-07T00:00:00Z",
					model: "native",
					provider: "azure-openai",
					inputTokens: 100,
					outputTokens: 5,
					totalTokens: 105,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					costBasis: "unknown",
					estimatedCostUsd: null,
					dataQuality: "quarantined_no_pricing",
					sessionType: "tedi",
					source: "ai-gateway-log",
					sessionCount: 1,
					success: true,
					cached: false,
				},
				deploymentScope: {},
				financialManifestSnapshot: {},
				approvalDecisionSnapshot: {},
				originalSourceVersion: 1,
				inputTokens: 100,
				outputTokens: 5,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				providerEstimatedCostMicros: 2197,
				financialWorkVersion: 3,
				nativeUsageKnown: true,
				kind: "provider_estimate",
				currency: "USD",
				pricingBasis: "reported_estimate",
				reportedEstimateSnapshot: { original: true },
				reportedCostDecimal: "0.00219662",
				reportedReporter: "cloudflare_ai_gateway",
			});
			expect(
				await listCostRollups(query, "orchard", "2026-10-07", "2026-10-07"),
			).toEqual([]);
		});
	});
