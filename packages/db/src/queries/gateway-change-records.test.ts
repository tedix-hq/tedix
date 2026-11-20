import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import {
	gatewayChangeRecordCheckpoints,
	gatewayChangeRecords,
} from "../schema/gateway-change-records";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	countGatewayChangeRecordsInRange,
	getGatewayChangeRecordStats,
	getLatestGatewayChangeRecordCheckpoint,
	getUnsealedGatewayChangeRecordStats,
	listGatewayChangeRecordCheckpoints,
	listGatewayChangeRecordsInRange,
	listOrganizationsWithUnsealedGatewayChangeRecords,
	listUnsealedGatewayChangeRecords,
	pruneGatewayChangeRecords,
	sealGatewayChangeRecords,
} from "./gateway-change-records";

const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});

function setup(rows: Array<[organizationId: string, recordedAt: string]>) {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec(schemaDdl(gatewayChangeRecords, gatewayChangeRecordCheckpoints));
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

/** A fake 64-hex chain value; these tests check storage, not hashing. */
const hex = (n: number) => n.toString(16).padStart(64, "0");

/**
 * Seal `sequences` of one organization as a run continuing after
 * `afterSequence`, with a checkpoint sealed at `sealedAt`.
 */
function sealParams(
	organizationId: string,
	sequences: number[],
	afterSequence: number,
	sealedAt: string,
) {
	const last = sequences.at(-1) ?? 0;
	return {
		organizationId,
		afterSequence,
		seals: sequences.map((sequence) => ({
			sequence,
			recordDigest: hex(sequence + 1000),
			chainHash: hex(sequence),
		})),
		checkpoint: {
			id: `checkpoint-${organizationId}-${sequences[0]}`,
			firstSequence: sequences[0] ?? 0,
			lastSequence: last,
			recordCount: sequences.length,
			headChainHash: hex(last),
			previousCheckpointDigest: null,
			previousChainHash: afterSequence ? hex(afterSequence) : null,
			checkpointDigest: hex(last + 5000),
			sealedAt,
			envelope: null,
			keyId: null,
		},
	};
}

describe("gateway change record retention", () => {
	const before = "2026-08-01T00:00:00.000Z";

	it("deletes whole old checkpoints only, never unsealed rows, capped per run", async () => {
		const { sqlite, db } = setup([
			["org-a", "2026-07-01T00:00:00.000Z"], // 1
			["org-b", "2026-07-02T00:00:00.000Z"], // 2
			["org-a", "2026-07-03T00:00:00.000Z"], // 3
			["org-b", "2026-07-04T00:00:00.000Z"], // 4
			["org-a", "2026-07-05T00:00:00.000Z"], // 5
			["org-a", "2026-07-06T00:00:00.000Z"], // 6
			["org-b", "2026-07-07T00:00:00.000Z"], // 7: never sealed
			["org-a", "2026-07-31T00:00:00.000Z"], // 8
		]);
		// org-a: [1,3] sealed in July, [5,6] in July, [8] on the cut-off.
		expect(
			await sealGatewayChangeRecords(
				db,
				sealParams("org-a", [1, 3], 0, "2026-07-10T00:00:00.000Z"),
			),
		).toBe(true);
		expect(
			await sealGatewayChangeRecords(
				db,
				sealParams("org-a", [5, 6], 3, "2026-07-20T00:00:00.000Z"),
			),
		).toBe(true);
		expect(
			await sealGatewayChangeRecords(db, sealParams("org-a", [8], 6, before)),
		).toBe(true);
		// org-b: [2,4] sealed in July; 7 stays unsealed.
		expect(
			await sealGatewayChangeRecords(
				db,
				sealParams("org-b", [2, 4], 0, "2026-07-10T00:00:00.000Z"),
			),
		).toBe(true);

		// Nothing leaves before a verified copy of its checkpoint is stored.
		const params = { before, batchSize: 2, maxBatches: 1 };
		expect(await pruneGatewayChangeRecords(db, params)).toBe(0);
		sqlite.exec(
			"update gateway_change_record_checkpoints set evidence_bundle_key = 'bundle'",
		);
		// A sample of two sealed rows (1 and 2) reaches the checkpoints of both
		// organizations and deletes them whole, including 3 and 4.
		expect(await pruneGatewayChangeRecords(db, params)).toBe(4);
		expect(remaining(sqlite)).toEqual([
			"record-4",
			"record-5",
			"record-6",
			"record-7",
		]);
		// The next run takes [5,6]; [8]'s checkpoint is not older than the
		// cut-off and 7 is not sealed, so both stay.
		expect(await pruneGatewayChangeRecords(db, params)).toBe(2);
		expect(await pruneGatewayChangeRecords(db, params)).toBe(0);
		expect(remaining(sqlite)).toEqual(["record-6", "record-7"]);
		// Checkpoints are never deleted, and the kept row's predecessor chain
		// hash stays on its checkpoint.
		expect(
			await listGatewayChangeRecordCheckpoints(db, "org-a", { limit: 10 }),
		).toMatchObject([
			{ firstSequence: 1, lastSequence: 3 },
			{ firstSequence: 5, lastSequence: 6 },
			{ firstSequence: 8, lastSequence: 8, previousChainHash: hex(6) },
		]);
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
});

describe("gateway change record sealing", () => {
	it("writes a run and its checkpoint together, and refuses a fork", async () => {
		const { sqlite, db } = setup([
			["org-a", "2026-11-18T10:00:00.000Z"], // 1
			["org-b", "2026-11-18T10:00:01.000Z"], // 2
			["org-a", "2026-11-18T10:00:02.000Z"], // 3
			["org-a", "2026-11-18T10:00:03.000Z"], // 4
		]);
		expect(
			await listOrganizationsWithUnsealedGatewayChangeRecords(db, 10),
		).toEqual(["org-a", "org-b"]);
		expect(
			(
				await listUnsealedGatewayChangeRecords(db, "org-a", {
					afterSequence: 0,
					limit: 10,
				})
			).map((record) => record.sequence),
		).toEqual([1, 3, 4]);

		const sealedAt = "2026-11-18T10:05:00.000Z";
		expect(
			await sealGatewayChangeRecords(
				db,
				sealParams("org-a", [1, 3], 0, sealedAt),
			),
		).toBe(true);
		expect(
			await getLatestGatewayChangeRecordCheckpoint(db, "org-a"),
		).toMatchObject({
			firstSequence: 1,
			lastSequence: 3,
			headChainHash: hex(3),
		});
		expect(await getUnsealedGatewayChangeRecordStats(db)).toEqual({
			rows: 2,
			oldestRecordedAt: "2026-11-18T10:00:01.000Z",
		});

		// A second run that read the same starting point: its checkpoint
		// collides and nothing of it is written, not even row 4.
		expect(
			await sealGatewayChangeRecords(
				db,
				sealParams("org-a", [1, 3, 4], 0, sealedAt),
			),
		).toBe(false);
		const sealed = () =>
			sqlite
				.prepare(
					"SELECT sequence, chain_hash FROM gateway_change_records WHERE chain_hash IS NOT NULL ORDER BY sequence",
				)
				.all()
				.map((row) => [row.sequence, row.chain_hash]);
		expect(sealed()).toEqual([
			[1, hex(1)],
			[3, hex(3)],
		]);

		// A run that continues from a stale point (after 1, though 3 is sealed)
		// fails the last-sealed-sequence guard and is refused as a whole.
		expect(
			await sealGatewayChangeRecords(db, {
				...sealParams("org-a", [4], 1, sealedAt),
				checkpoint: {
					...sealParams("org-a", [4], 1, sealedAt).checkpoint,
					id: "stale",
				},
			}),
		).toBe(false);
		expect(sealed()).toEqual([
			[1, hex(1)],
			[3, hex(3)],
		]);
		expect(
			sqlite
				.prepare("SELECT count(*) AS n FROM gateway_change_record_checkpoints")
				.get(),
		).toEqual({ n: 1 });

		// The right continuation lands.
		expect(
			await sealGatewayChangeRecords(db, sealParams("org-a", [4], 3, sealedAt)),
		).toBe(true);
		expect(
			await listOrganizationsWithUnsealedGatewayChangeRecords(db, 10),
		).toEqual(["org-b"]);
		const [page] = await Promise.all([
			listGatewayChangeRecordCheckpoints(db, "org-a", {
				fromSequence: 4,
				limit: 10,
			}),
		]);
		expect(page.map((checkpoint) => checkpoint.firstSequence)).toEqual([4]);
	});

	it("reads the unsealed queue through its partial index", () => {
		const { sqlite } = setup([]);
		const plan = sqlite
			.prepare(
				"EXPLAIN QUERY PLAN SELECT * FROM gateway_change_records WHERE organization_id = ? AND chain_hash IS NULL AND sequence > ? ORDER BY sequence LIMIT 100",
			)
			.all("org-a", 0)
			.map((row) => String(row.detail));
		expect(plan.join("\n")).toContain("idx_gateway_change_records_unsealed");
	});

	it("checks the last-sealed guard through the sealed-only index", () => {
		const { sqlite } = setup([]);
		const plan = sqlite
			.prepare(
				"EXPLAIN QUERY PLAN SELECT 1 FROM gateway_change_records AS later WHERE later.organization_id = ? AND later.sequence > ? AND later.chain_hash IS NOT NULL",
			)
			.all("org-a", 0)
			.map((row) => String(row.detail));
		expect(plan.join("\n")).toContain("idx_gateway_change_records_sealed");
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

	it("filters by the Work Item a record is about", async () => {
		const { sqlite, db } = setup([
			["org-a", "2026-11-18T01:00:00.000Z"],
			["org-a", "2026-11-18T02:00:00.000Z"],
			["org-a", "2026-11-18T03:00:00.000Z"],
		]);
		const subjectId = "3f2b8c1e-6d4a-4f7b-9a2e-5c1d8e7f6a90";
		const setSubject = sqlite.prepare(
			"UPDATE gateway_change_records SET record = ? WHERE id = ?",
		);
		setSubject.run(
			JSON.stringify({ subject: { kind: "work_item", id: subjectId } }),
			"record-0",
		);
		setSubject.run(
			JSON.stringify({
				subject: {
					kind: "work_item",
					id: "8a1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
				},
			}),
			"record-1",
		);
		const filtered = { ...range, subjectId };
		expect(await countGatewayChangeRecordsInRange(db, "org-a", filtered)).toBe(
			1,
		);
		const records = await listGatewayChangeRecordsInRange(
			db,
			"org-a",
			filtered,
			{ limit: 10 },
		);
		expect(records.map((record) => record.id)).toEqual(["record-0"]);
		expect(records[0]).toMatchObject({
			subject: { kind: "work_item", id: subjectId },
		});
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
