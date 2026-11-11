import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { configureLogStore, createDbClient } from "../client";
import { billingProviderCostEvidenceVersions } from "../schema/billing";
import { logPartition } from "../schema/logs-db";
import { tediCallCosts, tedis } from "../schema/tedis";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl, tableDdl } from "../test/schema-ddl";
import { listOrgCallCostLedger } from "./usage-ledger";

const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});

function fixture() {
	const main = new DatabaseSync(":memory:", {
		enableForeignKeyConstraints: false,
	});
	const logs = new DatabaseSync(":memory:");
	const history = new DatabaseSync(":memory:");
	databases.push(main, logs, history);
	main.exec(
		schemaDdl(tediCallCosts, tedis, billingProviderCostEvidenceVersions),
	);
	for (const sqlite of [logs, history])
		sqlite.exec(
			[tediCallCosts, logPartition]
				.flatMap((table) => tableDdl(table, { foreignKeys: false }))
				.join("\n"),
		);
	const db = createDbClient(createD1Facade(main));
	configureLogStore(db, {
		LOGS_DB: createD1Facade(logs),
		LOGS_DB_1: createD1Facade(history),
	});
	const seed = (
		sqlite: DatabaseSync,
		id: string,
		day: string,
		org = "fictional-lighthouse",
		tokens = 10,
	) => {
		sqlite
			.prepare(`INSERT INTO tedi_call_costs
			(id, org_id, gateway_log_id, gateway_id, snapshot_at, model, total_tokens, estimated_cost_usd, source)
			VALUES (?, ?, ?, 'gateway', ?, 'fictional-model', ?, 0.01, 'ai-gateway-log')`)
			.run(id, org, id, day, tokens);
	};
	return { db, main, logs, history, seed };
}

describe("organization cost ledger archives", () => {
	it("merges historical partitions, keeps main during overlap, scopes tenants, and pages by the merged cursor", async () => {
		const { db, main, logs, history, seed } = fixture();
		seed(main, "recent", "2026-10-20");
		seed(main, "overlap", "2024-09-02", "fictional-lighthouse", 99);
		seed(logs, "overlap", "2024-09-02");
		seed(logs, "moved", "2024-09-01");
		seed(history, "oldest", "2024-08-01");
		seed(history, "other-tenant", "2026-10-21", "fictional-other");
		const first = await listOrgCallCostLedger(db, {
			organizationId: "fictional-lighthouse",
			limit: 2,
		});
		expect(first.map((row) => row.id)).toEqual(["recent", "overlap"]);
		expect(first[1]?.totalTokens).toBe(99);
		const last = first[1]!;
		const next = await listOrgCallCostLedger(db, {
			organizationId: "fictional-lighthouse",
			limit: 2,
			cursor: { id: last.id, snapshotAt: last.snapshotAt },
		});
		expect(next.map((row) => row.id)).toEqual(["moved", "oldest"]);
		expect(next[0]).toMatchObject({
			orgId: "fictional-lighthouse",
			estimatedCostUsd: 0.01,
			providerCostEvidence: null,
			sourceRetired: false,
		});
	});

	it("hydrates more than one archive batch and applies time filters in every partition", async () => {
		const { db, logs, history, seed } = fixture();
		for (let i = 0; i < 105; i++)
			seed(logs, `moved-${String(i).padStart(3, "0")}`, "2024-09-01");
		seed(history, "too-old", "2023-01-01");
		const rows = await listOrgCallCostLedger(db, {
			organizationId: "fictional-lighthouse",
			from: "2024-01-01",
			to: "2025-01-01",
			limit: 105,
		});
		expect(rows).toHaveLength(105);
		expect(new Set(rows.map((row) => row.id)).size).toBe(105);
		expect(rows[0]?.id).toBe("moved-104");
	});
});
