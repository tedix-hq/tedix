import { billingProviderCostEvidenceVersions } from "../schema/billing";
/**
 * Quarantined value must not reach the cost anomaly detector.
 *
 * This module disagreed with itself. `getCallCostTotals` (:121) and
 * `getTediCallCostTotals` (:171) both sum spend as
 * `SUM(CASE WHEN data_quality = 'ok' THEN estimated_cost_usd ELSE 0 END)`,
 * because a quarantined row is value the ingestion job HELD OUT — it is not
 * spend. The two sums feeding `getDailySpendRate` summed unfiltered, so the
 * alerting path was the one place that counted held-out value as money.
 *
 * The baseline matters as much as the window. An anomaly score is a RATIO, so a
 * baseline that includes quarantined value while the window excludes it (or the
 * reverse) moves the score whenever the QUARANTINE RATE changes, with no change
 * in real spend. That is a false anomaly manufactured by the detector itself.
 *
 * Excluding quarantine correctly introduces the opposite risk — a detector that
 * goes quiet because pricing broke looks identical to one with nothing to
 * report — so the held-out portion is reported beside spend rather than
 * dropped, and these tests pin that too.
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { tediCallCosts } from "../schema/tedis";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { getDailySpendRate } from "./tedi-usage";

function fixture(): { db: DbClient; sqlite: DatabaseSync } {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(schemaDdl(tediCallCosts, billingProviderCostEvidenceVersions));
	return { db: createDbClient(createD1Facade(sqlite)) as DbClient, sqlite };
}

let seq = 0;
/** Columns exactly as `ingestGatewayLogCosts` writes them. */
function insertCost(
	sqlite: DatabaseSync,
	input: {
		dataQuality?: "ok" | "quarantined_no_pricing" | "quarantined_failed";
		estimatedCostUsd?: number;
		hoursAgo?: number;
		model?: string;
	},
) {
	seq++;
	sqlite
		.prepare(
			`INSERT INTO tedi_call_costs (
				id, tedi_id, org_id, gateway_log_id, gateway_id, snapshot_at, model,
				provider, session_type, source, input_tokens, output_tokens,
				cache_read_tokens, cache_write_tokens, total_tokens,
				estimated_cost_usd, session_count, success, cached, data_quality
			) VALUES (?, 'tedi-1', 'org-1', ?, 'tedix-llm-production', ?, ?,
				'azure-openai', 'tedi', 'ai-gateway-log', 100, 0, 0, 0, 100,
				?, 1, 1, 0, ?)`,
		)
		.run(
			`cost-${seq}`,
			`log-${seq}`,
			new Date(
				Date.now() - (input.hoursAgo ?? 1) * 60 * 60 * 1000,
			).toISOString(),
			input.model ?? "gpt-5.6-luna",
			input.estimatedCostUsd ?? 0,
			input.dataQuality ?? "ok",
		);
}

describe("getDailySpendRate excludes held-out value from spend", () => {
	it("does not count a quarantined row's cost as daily spend", async () => {
		const { db, sqlite } = fixture();
		insertCost(sqlite, { estimatedCostUsd: 1, hoursAgo: 1 });
		insertCost(sqlite, {
			estimatedCostUsd: 99,
			dataQuality: "quarantined_failed",
			hoursAgo: 1,
		});

		const rate = await getDailySpendRate(db, null, 1);

		// Only the priced row is spend. The 99 is held out, not earned.
		expect(rate.daily_usd).toBeNull();
		expect(rate.knownSubtotalUsd).toBe(1);
		expect(rate.quarantined_usd).toBe(99);
		// Row count still covers every row, so the held-out share is legible.
		expect(rate.daily_calls).toBe(2);
		expect(rate.quarantined_calls).toBe(1);
	});

	it("does not let a quarantine spike manufacture an anomaly", async () => {
		const { db, sqlite } = fixture();
		// A flat baseline of real spend across the trailing week.
		for (let day = 2; day <= 8; day++) {
			// Keep every fixture one hour inside the interval. Exact boundary
			// timestamps are created before getDailySpendRate captures `now`, so
			// clock progress would otherwise exclude the oldest row by milliseconds.
			insertCost(sqlite, { estimatedCostUsd: 1, hoursAgo: day * 24 - 1 });
		}
		// Today: identical REAL spend, plus a burst of unpriceable rows. Nothing
		// about actual cost changed, so nothing should fire.
		insertCost(sqlite, { estimatedCostUsd: 1, hoursAgo: 1 });
		for (let i = 0; i < 20; i++) {
			insertCost(sqlite, {
				estimatedCostUsd: 50,
				dataQuality: "quarantined_no_pricing",
				hoursAgo: 1,
			});
		}

		const rate = await getDailySpendRate(db, null, 1);

		expect(rate.daily_usd).toBeNull();
		expect(rate.knownSubtotalUsd).toBe(1);
		expect(rate.anomaly_score).toBeNull();
		// The burst is still visible — suppressing the false alarm must not make
		// a broken pricing path invisible.
		expect(rate.quarantined_usd).toBe(1000);
		expect(rate.quarantined_calls).toBe(20);
	});

	it("keeps the baseline on the same footing as the window", async () => {
		const { db, sqlite } = fixture();
		// Baseline week: real spend 1/day, PLUS large quarantined rows. If the
		// baseline counted those, the average would be inflated and a genuine
		// spike today would be masked — the dangerous direction.
		for (let day = 2; day <= 8; day++) {
			insertCost(sqlite, { estimatedCostUsd: 1, hoursAgo: day * 24 - 1 });
			insertCost(sqlite, {
				estimatedCostUsd: 100,
				dataQuality: "quarantined_failed",
				hoursAgo: day * 24 - 1,
			});
		}
		// Today: a real 10x spike on priced spend.
		insertCost(sqlite, { estimatedCostUsd: 10, hoursAgo: 1 });

		const rate = await getDailySpendRate(db, null, 1);

		expect(rate.daily_usd).toBe(10);
		expect(rate.sevenDayAvgDailyUsd).toBeNull();
		// An incomplete historical baseline cannot support a numerical spike.
		expect(rate.anomaly_score).toBeNull();
	});

	it("still fires on a real spike with no quarantine anywhere", async () => {
		const { db, sqlite } = fixture();
		for (let day = 2; day <= 8; day++) {
			insertCost(sqlite, { estimatedCostUsd: 1, hoursAgo: day * 24 - 1 });
		}
		insertCost(sqlite, { estimatedCostUsd: 10, hoursAgo: 1 });

		const rate = await getDailySpendRate(db, null, 1);

		expect(rate.anomaly_score).toBe(1);
		expect(rate.quarantined_usd).toBe(0);
	});
});
