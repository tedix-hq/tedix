import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import { tediCallCosts } from "../../schema/tedis";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { getRecentProviderPricingHealth } from "./health";

const window = {
	sinceInclusive: "2026-09-19T08:00:00.000Z",
	untilExclusive: "2026-09-20T08:00:00.000Z",
};
function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(tediCallCosts));
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
