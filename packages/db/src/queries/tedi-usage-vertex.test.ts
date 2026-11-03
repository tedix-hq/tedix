/**
 * Direct-Vertex ledger rows + the provider spend window that gates dispatch.
 * Rows built by `buildVertexCallCostRow` are usage evidence only — they carry
 * no `executionId`, so billing settlement can never invoice them; the window
 * totals give the platform its GCP-side daily budget + request cap.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { tediCallCosts } from "../schema/tedis";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	buildVertexCallCostRow,
	getProviderSpendWindowTotals,
	insertCallCosts,
} from "./tedi-usage";

function fixture(): { db: DbClient; sqlite: DatabaseSync } {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(schemaDdl(tediCallCosts));
	return { db: createDbClient(createD1Facade(sqlite)) as DbClient, sqlite };
}

describe("buildVertexCallCostRow", () => {
	it("attributes a priced tedi call to the vertex-direct ledger", () => {
		const row = buildVertexCallCostRow({
			orgId: "org-1",
			tediId: "tedi-1",
			runId: "run-1",
			source: "vertex-direct:skill-network",
			model: "gemini-2.5-flash-image",
			tokens: { inputTokens: 10, outputTokens: 1290 },
			usageKind: "image_generation",
			usageUnit: "images",
			usageQuantity: 1,
			priced: { costUsd: 0.039, rateVersionId: "rate-1" },
		});
		expect(row.provider).toBe("google-vertex");
		expect(row.gatewayId).toBe("vertex-direct");
		expect(row.sessionType).toBe("tedi");
		expect(row.dataQuality).toBe("ok");
		expect(row.costBasis).toBe("governed_estimate");
		expect(row.totalTokens).toBe(1300);
		expect(row.executionId ?? null).toBeNull();
	});

	it("demotes an org-scoped session type when orgId is missing", () => {
		const row = buildVertexCallCostRow({
			orgId: null,
			tediId: "tedi-1",
			source: "vertex-direct:test",
			model: "m",
		});
		expect(row.sessionType).toBe("unattributed");
		expect(row.costBasis).toBe("unknown");
		expect(row.dataQuality).toBe("quarantined_no_pricing");
	});

	it("marks a failed call as held usage evidence, never spend", () => {
		const row = buildVertexCallCostRow({
			orgId: "org-1",
			source: "vertex-direct:test",
			model: "m",
			success: false,
			priced: { costUsd: 5, rateVersionId: "rate-1" },
		});
		expect(row.success).toBe(false);
		expect(row.dataQuality).toBe("quarantined_failed");
		expect(row.estimatedCostUsd).toBeNull();
	});
});

describe("getProviderSpendWindowTotals", () => {
	it("sums only the requested provider's recorded window", async () => {
		const { db, sqlite } = fixture();
		await insertCallCosts(db, [
			buildVertexCallCostRow({
				orgId: "org-1",
				tediId: "tedi-1",
				source: "vertex-direct:a",
				model: "m1",
				snapshotAt: new Date().toISOString(),
				tokens: { inputTokens: 5, outputTokens: 5 },
				priced: { costUsd: 2, rateVersionId: "r" },
			}),
			buildVertexCallCostRow({
				orgId: "org-1",
				source: "vertex-direct:b",
				model: "m2",
				snapshotAt: new Date().toISOString(),
			}),
		]);
		sqlite
			.prepare(
				`INSERT INTO tedi_call_costs (id, gateway_log_id, gateway_id, snapshot_at, model, provider, session_type, source, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, session_count, success, cached, data_quality)
				 VALUES ('other', 'log-other', 'gw', ?, 'm', 'azure-openai', 'kernel', 'ai-gateway-log', 1, 1, 0, 0, 2, 1, 1, 0, 'ok')`,
			)
			.run(new Date().toISOString());
		sqlite
			.prepare(
				`INSERT INTO tedi_call_costs (id, gateway_log_id, gateway_id, snapshot_at, model, provider, session_type, source, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, session_count, success, cached, data_quality)
				 VALUES ('old', 'log-old', 'vertex-direct', '2020-01-01T00:00:00.000Z', 'm', 'google-vertex', 'kernel', 'vertex-direct:old', 1, 1, 0, 0, 2, 1, 1, 0, 'ok')`,
			)
			.run();

		const totals = await getProviderSpendWindowTotals(db, {
			provider: "google-vertex",
			since: new Date().toISOString().slice(0, 10) + "T00:00:00.000Z",
		});
		expect(totals.callCount).toBe(2);
		expect(totals.knownCostUsd).toBe(2);
		expect(totals.totalTokens).toBe(10);
		expect(totals.quarantinedCalls).toBe(1);
	});
});
