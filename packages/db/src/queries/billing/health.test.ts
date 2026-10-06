import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import { providerExecutionAttempts } from "../../schema/provider-executions";
import { tediCallCosts } from "../../schema/tedis";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import {
	billingUsageReservations,
	billingUsageCharges,
	billingUsageQuarantines,
} from "../../schema/billing";
import {
	getRecentProviderAttributionHealth,
	getRecentProviderPricingHealth,
} from "./health";

const window = {
	sinceInclusive: "2026-09-19T08:00:00.000Z",
	untilExclusive: "2026-09-20T08:00:00.000Z",
};
function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	for (const table of [
		tediCallCosts,
		billingUsageReservations,
		billingUsageCharges,
		billingUsageQuarantines,
		providerExecutionAttempts,
	])
		sqlite.exec(schemaDdl(table));
	const db = createDbClient(createD1Facade(sqlite));
	let seq = 0;
	const insert = async (
		patch: Partial<typeof tediCallCosts.$inferInsert> = {},
	) => {
		seq++;
		await db.insert(tediCallCosts).values({
			id: `row-${seq}`,
			gatewayLogId: `log-${seq}`,
			gatewayId: "gateway",
			snapshotAt: window.sinceInclusive,
			model: "native-model",
			provider: "azure-openai",
			source: "ai-gateway-log:kernel",
			sessionType: "unattributed",
			totalTokens: 12,
			estimatedCostUsd: null,
			costBasis: "unknown",
			costReason: "missing_rate",
			dataQuality: "quarantined_no_pricing",
			...patch,
		});
	};
	return { db, sqlite, insert };
}

describe("recent provider pricing evidence", () => {
	it("counts unreserved and unattributed evidence, preserves zero, and uses a half-open native-event window", async () => {
		const { db, sqlite, insert } = fixture();
		await insert({ orgId: "org", billingReservationId: "reservation" });
		await insert({ costReason: "unverified_execution" });
		await insert({
			costReason: "invalid_usage",
			success: false,
			dataQuality: "quarantined_failed",
		});
		await insert({
			costReason: null,
			costBasis: "legacy_estimate",
			estimatedCostUsd: 0,
		});
		await insert({ costReason: "new-arbitrary-reason" });
		for (const amount of [0, 1.23])
			await insert({
				costReason: null,
				costBasis: "gateway_reported",
				estimatedCostUsd: amount,
				dataQuality: "ok",
				provider: "workers-ai",
			});
		await insert({
			costReason: null,
			costBasis: "legacy_estimate",
			estimatedCostUsd: 0.01,
			dataQuality: "ok",
		});
		await insert({ snapshotAt: "2026-09-19T07:59:59.999Z" });
		await insert({ snapshotAt: window.untilExclusive });
		await insert({ snapshotAt: "2026-09-21T00:00:00.000Z" });
		await insert({
			usageKind: "voice_stt",
			usageUnit: "seconds",
			usageQuantity: 3,
		});
		await insert({ source: "ai-gateway-log:voice-stt" });
		await insert({ source: "non-gateway-model-observation" });
		await insert({ provider: "other" });
		const before = sqlite.prepare("SELECT total_changes() AS n").get();
		const health = await getRecentProviderPricingHealth(db, window);
		expect(health).toMatchObject({
			affectedRows: 5,
			affectedTokens: 60,
			unattributedRows: 4,
			unreservedRows: 4,
			missingRateRows: 1,
			omittedGroupCount: 0,
			firstObservedAt: window.sinceInclusive,
			lastObservedAt: window.sinceInclusive,
		});
		expect(health.groups.map((g) => g.reason).sort()).toEqual([
			"invalid_usage",
			"legacy_unspecified_no_pricing",
			"missing_rate",
			"unknown_reason",
			"unverified_execution",
		]);
		expect(
			health.groups.every(
				(g) =>
					g.deployment === null &&
					g.providerResource === null &&
					g.providerOrigin === null,
			),
		).toBe(true);
		expect(sqlite.prepare("SELECT total_changes() AS n").get()).toEqual(before);
		expect(
			await getRecentProviderPricingHealth(db, {
				sinceInclusive: "2026-09-22T00:00:00.000Z",
				untilExclusive: "2026-09-23T00:00:00.000Z",
			}),
		).toMatchObject({ affectedRows: 0, groups: [], firstObservedAt: null });
		sqlite.close();
	});
	it("keeps persisted deployment scopes separate without inferring them from model names", async () => {
		const { db, sqlite, insert } = fixture();
		await insert({
			model: "qualified/model",
			providerResource: "resource-a",
			providerBaseUrl: "https://resource-a.openai.azure.com",
			deployment: "custom-a",
			costReason: "ambiguous_scope",
		});
		await insert({
			model: "qualified/model",
			providerResource: "resource-b",
			providerBaseUrl: "https://resource-b.openai.azure.com",
			deployment: "custom-b",
			costReason: "ambiguous_scope",
		});
		const health = await getRecentProviderPricingHealth(db, window);
		expect(
			health.groups.map((group) => [
				group.providerResource,
				group.providerOrigin,
				group.deployment,
			]),
		).toEqual([
			["resource-a", "https://resource-a.openai.azure.com", "custom-a"],
			["resource-b", "https://resource-b.openai.azure.com", "custom-b"],
		]);
		expect(health.affectedRows).toBe(2);
		sqlite.close();
	});
	it("bounds examples while totals include every group with deterministic ordering", async () => {
		const { db, sqlite, insert } = fixture();
		for (let i = 0; i < 12; i++)
			await insert({
				model: `model-${String(i).padStart(2, "0")}`,
				costReason: i === 11 ? "missing_rate" : "rate_lookup_failed",
			});
		await insert({ model: "model-11" });
		const health = await getRecentProviderPricingHealth(db, window);
		expect(health).toMatchObject({
			affectedRows: 13,
			affectedTokens: 156,
			omittedGroupCount: 2,
			missingRateRows: 2,
		});
		expect(health.groups).toHaveLength(10);
		expect(health.groups.map((g) => g.model)).toEqual([
			"model-11",
			...Array.from({ length: 9 }, (_, i) => `model-0${i}`),
		]);
		expect(await getRecentProviderPricingHealth(db, window)).toEqual(health);
		await expect(
			getRecentProviderPricingHealth(db, {
				...window,
				sinceInclusive: window.untilExclusive,
			}),
		).rejects.toThrow("Invalid provider pricing health window");
		sqlite.close();
	});
});

async function reservation(
	db: ReturnType<typeof fixture>["db"],
	id: string,
	status: "expired" | "settled" | "released" | "rejected" = "expired",
	organizationId = "org",
) {
	await db.insert(billingUsageReservations).values({
		id,
		organizationId,
		planVersionId: "plan",
		status,
		source: "kernel",
		provider: "workers-ai",
		model: "model",
		periodStart: window.sinceInclusive,
		periodEnd: window.untilExclusive,
		idempotencyKey: id,
		expiresAt: window.sinceInclusive,
	});
}
async function charge(
	db: ReturnType<typeof fixture>["db"],
	log: string,
	reservationId: string,
	organizationId = "org",
) {
	await db.insert(billingUsageCharges).values({
		id: `charge-${log}`,
		organizationId,
		reservationId,
		usagePeriodId: "period",
		gatewayLogId: log,
		provider: "workers-ai",
		model: "model",
		source: "kernel",
		occurredAt: window.sinceInclusive,
	});
}
async function hold(
	db: ReturnType<typeof fixture>["db"],
	log: string,
	organizationId: string | null = "org",
	sourceSnapshotAt = window.sinceInclusive,
) {
	await db.insert(billingUsageQuarantines).values({
		id: `hold-${log}`,
		gatewayLogId: log,
		organizationId,
		sourceSnapshotAt,
		reason: "missing_reservation",
		metadata: { reservationId: "untrusted" },
	});
}
describe("recent platform attribution coverage", () => {
	it("includes priced NULL-org zero/positive evidence with half-open token-only scope and no writes", async () => {
		const { db, sqlite, insert } = fixture();
		await insert({
			cached: true,
			provider: "workers-ai",
			estimatedCostUsd: 0,
			dataQuality: "ok",
			costBasis: "gateway_reported",
		});
		await insert({
			provider: "workers-ai",
			estimatedCostUsd: 1.23,
			dataQuality: "ok",
			costBasis: "gateway_reported",
			success: false,
		});
		await insert({ orgId: "org" });
		await insert({
			orgId: "org",
			estimatedCostUsd: 0,
			dataQuality: "ok",
			costBasis: "gateway_reported",
		});
		for (const patch of [
			{ snapshotAt: window.untilExclusive },
			{ snapshotAt: "2026-09-18T08:00:00.000Z" },
			{ source: "ai-gateway-log:voice-stt" },
			{ usageKind: "image_generation" },
			{ source: "local" },
			{ provider: "other" },
		])
			await insert(patch);
		const before = sqlite.prepare("SELECT total_changes() AS n").get()!.n;
		const h = await getRecentProviderAttributionHealth(db, window);
		expect(h).toMatchObject({
			totalRows: 4,
			totalTokens: 48,
			unattributedRows: 2,
			unattributedTokens: 24,
			expiredObservedRows: 0,
		});
		expect(h.groups).toContainEqual({
			provider: "workers-ai",
			ownership: "unproven",
			pricing: "priced",
			disposition: "unresolved",
			rowCount: 2,
			tokens: 24,
		});
		expect(
			(await getRecentProviderPricingHealth(db, window)).affectedRows,
		).toBe(1);
		expect(sqlite.prepare("SELECT total_changes() AS n").get()!.n).toBe(before);
		sqlite.close();
	});
	it("counts positive observations only and preserves late-charge precedence without receipt fanout", async () => {
		const { db, sqlite, insert } = fixture();
		await reservation(db, "unused");
		await db.insert(providerExecutionAttempts).values({
			id: "admission-only",
			organizationId: "org",
			source: "kernel",
			idempotencyKey: "unused",
			settlementMode: "managed",
			billingReservationId: "unused",
			provider: "workers-ai",
			requestModel: "model",
			gatewayAccountId: "fictional-account",
			gatewayId: "fictional-gateway",
			transportKind: "workers-ai-binding",
			apiKind: "workers-ai-chat",
			deploymentScope: "fictional-scope",
			authorizedAt: window.sinceInclusive,
			sendBefore: window.untilExclusive,
		});
		await reservation(db, "r");
		await insert({
			orgId: "org",
			billingReservationId: "r",
			gatewayLogId: "settled",
		});
		await charge(db, "settled", "r");
		await hold(db, "settled");
		await insert({
			orgId: "org",
			billingReservationId: "r",
			gatewayLogId: "held",
		});
		await hold(db, "held");
		await insert({
			orgId: "org",
			billingReservationId: "r",
			gatewayLogId: "pending",
		});
		await insert({ orgId: "org", billingReservationId: "r", totalTokens: 0 });
		await insert({ orgId: "org", billingReservationId: "r", success: false });
		for (const status of ["settled", "released", "rejected"] as const) {
			await reservation(db, status, status);
			await insert({ orgId: "org", billingReservationId: status });
		}
		expect(await getRecentProviderAttributionHealth(db, window)).toMatchObject({
			expiredObservedRows: 3,
			expiredReservations: 1,
			expiredSettledRows: 1,
			expiredHeldRows: 1,
			expiredUnresolvedRows: 1,
			historicalHoldRows: 1,
		});
		sqlite.close();
	});
	it("rejects wrong receipt tuples and NULL/stale holds while retaining valid conflicting late settlement", async () => {
		const { db, sqlite, insert } = fixture();
		await reservation(db, "r");
		for (const [log, kind] of [
			["wrong-org", "org"],
			["wrong-res", "res"],
			["null-hold", "null"],
			["stale-hold", "stale"],
			["valid-conflict", "valid"],
		]) {
			await insert({
				orgId: "org",
				billingReservationId: "r",
				gatewayLogId: log,
			});
			if (kind === "org") await charge(db, log!, "r", "other");
			if (kind === "res") {
				await charge(db, log!, "other");
				await hold(db, log!);
			}
			if (kind === "null") await hold(db, log!, null);
			if (kind === "stale") await hold(db, log!, "org", window.untilExclusive);
			if (kind === "valid") {
				await charge(db, log!, "r");
				await hold(db, log!, null);
			}
		}
		await insert({
			orgId: "org",
			billingReservationId: "r",
			gatewayLogId: "different-gateway",
		});
		await charge(db, "unrelated-gateway", "r");
		await insert({ orgId: "org", billingReservationId: "missing" });
		await insert({ orgId: "other", billingReservationId: "r" });
		expect(await getRecentProviderAttributionHealth(db, window)).toMatchObject({
			expiredObservedRows: 6,
			expiredReservations: 1,
			expiredSettledRows: 1,
			expiredHeldRows: 0,
			expiredUnresolvedRows: 1,
			relationshipUnprovenRows: 6,
			conflictingReceiptRows: 5,
		});
		sqlite.close();
	});
	it("preserves empty/full totals before LIMIT and refuses unsafe aggregates", async () => {
		const { db, sqlite, insert } = fixture();
		expect(await getRecentProviderAttributionHealth(db, window)).toMatchObject({
			totalRows: 0,
			groups: [],
		});
		await reservation(db, "r");
		for (const provider of ["azure-openai", "workers-ai"])
			for (const orgId of [null, "org"])
				for (const priced of [false, true])
					for (const disposition of [
						"settled",
						"held",
						"unresolved",
						"unproven",
					]) {
						const log = `${provider}-${orgId}-${priced}-${disposition}`;
						await insert({
							provider,
							orgId,
							billingReservationId:
								disposition === "unproven" ? "missing" : "r",
							gatewayLogId: log,
							...(priced
								? {
										estimatedCostUsd: 0,
										dataQuality: "ok" as const,
										costBasis: "gateway_reported" as const,
									}
								: {}),
						});
						if (disposition === "settled")
							await charge(db, log, "r", orgId ?? "other");
						if (disposition === "held") await hold(db, log, orgId);
					}
		const h = await getRecentProviderAttributionHealth(db, window);
		expect(h.totalRows).toBe(32);
		expect(h.totalTokens).toBe(384);
		expect(h.groups).toHaveLength(10);
		expect(h.omittedGroupCount).toBeGreaterThan(0);
		await expect(
			getRecentProviderAttributionHealth(db, {
				...window,
				sinceInclusive: window.untilExclusive,
			}),
		).rejects.toThrow("Invalid provider attribution health window");
		await insert({ totalTokens: Number.MAX_SAFE_INTEGER });
		await expect(
			getRecentProviderAttributionHealth(db, window),
		).rejects.toThrow();
		sqlite.close();
	});
});

describe("attribution window and source numeric integrity", () => {
	it("normalizes mixed offsets and rejects equivalent or reversed instants", async () => {
		const { db, sqlite, insert } = fixture();
		await insert();
		const h = await getRecentProviderAttributionHealth(db, window);
		expect(
			await getRecentProviderAttributionHealth(db, {
				sinceInclusive: "2026-09-19T10:00:00+02:00",
				untilExclusive: "2026-09-20T03:00:00-05:00",
			}),
		).toEqual(h);
		for (const bounds of [
			{
				sinceInclusive: "2026-09-19T10:00:00+02:00",
				untilExclusive: window.sinceInclusive,
			},
			{
				sinceInclusive: "2026-09-19T07:00:00-02:00",
				untilExclusive: "2026-09-19T10:00:00+02:00",
			},
			{ sinceInclusive: "bad", untilExclusive: window.untilExclusive },
		])
			await expect(
				getRecentProviderAttributionHealth(db, bounds),
			).rejects.toThrow("Invalid provider attribution health window");
		sqlite.close();
	});
	it.each(["cancelling", "negative", "fractional"])(
		"refuses invalid per-row %s tokens even with a safe-looking aggregate",
		async (kind) => {
			const { db, sqlite, insert } = fixture();
			await reservation(db, "r");
			await insert({
				orgId: "org",
				billingReservationId: "r",
				gatewayLogId: "numeric-a",
				totalTokens: 1,
			});
			if (kind === "cancelling") {
				await insert({
					orgId: "org",
					billingReservationId: "r",
					gatewayLogId: "numeric-b",
					totalTokens: 1,
				});
				sqlite
					.prepare(
						"UPDATE tedi_call_costs SET total_tokens=? WHERE gateway_log_id=?",
					)
					.run(9007199254740992n, "numeric-a");
				sqlite
					.prepare(
						"UPDATE tedi_call_costs SET total_tokens=? WHERE gateway_log_id=?",
					)
					.run(-9007199254740991n, "numeric-b");
			} else
				sqlite
					.prepare(
						"UPDATE tedi_call_costs SET total_tokens=? WHERE gateway_log_id=?",
					)
					.run(kind === "negative" ? -1 : 1.5, "numeric-a");
			await expect(
				getRecentProviderAttributionHealth(db, window),
			).rejects.toThrow("Invalid provider attribution health source tokens");
			sqlite.close();
		},
	);
	it("accepts a positive exact safe integer boundary", async () => {
		const { db, sqlite, insert } = fixture();
		await insert({ totalTokens: Number.MAX_SAFE_INTEGER });
		expect(
			(await getRecentProviderAttributionHealth(db, window)).totalTokens,
		).toBe(Number.MAX_SAFE_INTEGER);
		sqlite.close();
	});
});
