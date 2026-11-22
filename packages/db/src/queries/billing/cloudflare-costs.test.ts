import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { billingCloudflareDailyCosts } from "../../schema/billing";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import {
	cloudflareCostJumps,
	listCloudflareDailyCosts,
	upsertCloudflareDailyCost,
	type CloudflareDailyCost,
} from "./cloudflare-costs";

const row = (day: string, costMicros: number): CloudflareDailyCost => ({
	accountId: "test-account",
	service: "Dynamic Workers",
	day,
	costMicros,
	consumedQuantity: 25,
	consumedUnit: "requests",
	fetchedAt: "2026-11-22T02:00:00Z",
});

describe("Cloudflare daily platform costs", () => {
	it("replaces corrected costs on replay, keeps services/days separate, and bounds month reads", async () => {
		const sqlite = new DatabaseSync(":memory:");
		try {
			sqlite.exec(schemaDdl(billingCloudflareDailyCosts));
			const db = createDbQueryClient(createD1Facade(sqlite));
			await upsertCloudflareDailyCost(db, row("2026-10-31", 99));
			await upsertCloudflareDailyCost(db, row("2026-11-06", 7_000_000));
			await upsertCloudflareDailyCost(db, row("2026-11-06", 8_000_000));
			await upsertCloudflareDailyCost(db, {
				...row("2026-11-06", 3_000_000),
				service: "D1 rows written",
			});
			await upsertCloudflareDailyCost(db, row("2026-11-21", 74_000_000));
			const rows = await listCloudflareDailyCosts(
				db,
				"2026-11-01",
				"2026-11-06",
			);
			expect(rows).toHaveLength(2);
			expect(
				rows.map((r) => [
					r.service,
					r.costMicros,
					r.consumedQuantity,
					r.consumedUnit,
				]),
			).toEqual([
				["D1 rows written", 3_000_000, 25, "requests"],
				["Dynamic Workers", 8_000_000, 25, "requests"],
			]);
		} finally {
			sqlite.close();
		}
	});
	it("detects a jump using only the prior seven days; applies both strict thresholds and requires history", () => {
		const history = Array.from({ length: 7 }, (_, i) =>
			row(`2026-11-${String(14 + i).padStart(2, "0")}`, 7_000_000),
		);
		expect(
			cloudflareCostJumps(
				[...history, row("2026-11-21", 74_000_000)],
				"2026-11-21",
			),
		).toEqual([
			expect.objectContaining({
				averageMicros: 7_000_000,
				costMicros: 74_000_000,
			}),
		]);
		expect(
			cloudflareCostJumps(
				[...history, row("2026-11-21", 14_000_000)],
				"2026-11-21",
			),
		).toEqual([]);
		expect(
			cloudflareCostJumps(
				[
					...history.map((r) => ({ ...r, costMicros: 0 })),
					row("2026-11-21", 10_000_000),
				],
				"2026-11-21",
			),
		).toEqual([]);
		expect(
			cloudflareCostJumps(
				[...history.slice(1), row("2026-11-21", 74_000_000)],
				"2026-11-21",
			),
		).toEqual([]);
	});
});
