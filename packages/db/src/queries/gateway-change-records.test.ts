import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { gatewayChangeRecords } from "../schema/gateway-change-records";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	countGatewayChangeRecordsInRange,
	getGatewayChangeRecordStats,
	listGatewayChangeRecordsInRange,
	pruneGatewayChangeRecords,
} from "./gateway-change-records";

const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});

function setup(rows: Array<[organizationId: string, recordedAt: string]>) {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec(schemaDdl(gatewayChangeRecords));
	const insert = sqlite.prepare(
		"INSERT INTO gateway_change_records (id, organization_id, resource, actor_id, recorded_at, record) VALUES (?, ?, 'tool:x', 'user', ?, '{}')",
	);
	rows.forEach(([organizationId, recordedAt], index) =>
		insert.run(`record-${index}`, organizationId, recordedAt),
	);
	return { sqlite, db: createDbQueryClient(createD1Facade(sqlite)) };
}

const remaining = (sqlite: DatabaseSync) =>
	sqlite
		.prepare("SELECT id FROM gateway_change_records ORDER BY sequence")
		.all()
		.map((row) => row.id);

describe("gateway change record retention", () => {
	const before = "2026-08-01T00:00:00.000Z";

	it("deletes only older rows, in bounded batches capped per run", async () => {
		const { sqlite, db } = setup([
			["org-a", "2026-07-01T00:00:00.000Z"],
			["org-b", "2026-07-02T00:00:00.000Z"],
			["org-a", "2026-07-03T00:00:00.000Z"],
			["org-b", "2026-07-04T00:00:00.000Z"],
			["org-a", "2026-07-31T23:59:59.999Z"],
			["org-a", before],
			["org-b", "2026-08-02T00:00:00.000Z"],
		]);
		const params = { before, batchSize: 2, maxBatches: 2 };
		// Two full batches, then the run stops at its cap, oldest first.
		expect(await pruneGatewayChangeRecords(db, params)).toBe(4);
		expect(remaining(sqlite)).toEqual(["record-4", "record-5", "record-6"]);
		// The next run takes the rest; the cutoff itself is kept.
		expect(await pruneGatewayChangeRecords(db, params)).toBe(1);
		expect(remaining(sqlite)).toEqual(["record-5", "record-6"]);
		// Running again, or on an empty table, deletes nothing.
		expect(await pruneGatewayChangeRecords(db, params)).toBe(0);
		expect(await pruneGatewayChangeRecords(setup([]).db, params)).toBe(0);
	});

	it("reports the row count and oldest recorded-at", async () => {
		const { db } = setup([
			["org-b", "2026-07-02T00:00:00.000Z"],
			["org-a", "2026-07-01T00:00:00.000Z"],
		]);
		expect(await getGatewayChangeRecordStats(db)).toEqual({
			rows: 2,
			oldestRecordedAt: "2026-07-01T00:00:00.000Z",
		});
		expect(await getGatewayChangeRecordStats(setup([]).db)).toEqual({
			rows: 0,
			oldestRecordedAt: null,
		});
	});

	it("searches the recorded-at index for the retention batch", () => {
		const { sqlite } = setup([]);
		const plan = sqlite
			.prepare(
				"EXPLAIN QUERY PLAN SELECT sequence FROM gateway_change_records WHERE recorded_at < ? ORDER BY recorded_at LIMIT 500",
			)
			.all(before)
			.map((row) => String(row.detail));
		expect(plan.join("\n")).toContain(
			"USING COVERING INDEX idx_gateway_change_records_recorded_at",
		);
	});
});

describe("gateway change record time ranges", () => {
	const range = {
		from: "2026-11-18T00:00:00.000Z",
		until: "2026-11-19T00:00:00.000Z",
	};

	it("includes from, excludes until, and stays in one organization", async () => {
		const { db } = setup([
			["org-a", "2026-11-17T23:59:59.999Z"],
			["org-a", range.from],
			["org-b", "2026-11-18T12:00:00.000Z"],
			["org-a", "2026-11-18T23:59:59.999Z"],
			["org-a", range.until],
		]);
		expect(await countGatewayChangeRecordsInRange(db, "org-a", range)).toBe(2);
		expect(
			(
				await listGatewayChangeRecordsInRange(db, "org-a", range, {
					limit: 10,
				})
			).map((record) => record.id),
		).toEqual(["record-1", "record-3"]);
	});

	it("searches the organization/recorded-at index", () => {
		const { sqlite } = setup([]);
		const plan = sqlite
			.prepare(
				"EXPLAIN QUERY PLAN SELECT count(*) FROM gateway_change_records WHERE organization_id = ? AND recorded_at >= ? AND recorded_at < ?",
			)
			.all("org-a", range.from, range.until)
			.map((row) => String(row.detail));
		expect(plan.join("\n")).toContain(
			"idx_gateway_change_records_org_recorded_at (organization_id=? AND recorded_at>? AND recorded_at<?)",
		);
	});
});
