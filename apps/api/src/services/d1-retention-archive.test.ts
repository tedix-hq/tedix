import { DatabaseSync } from "node:sqlite";
import { createDbQueryClient } from "@tedix/db/query-client";
import { auditEvents } from "@tedix/db/schema/audit-events";
import { tediRuntimeEvents } from "@tedix/db/schema/cognitive-runtime";
import { d1RetentionPolicies } from "@tedix/db/schema/d1-retention";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it } from "vite-plus/test";
import { D1_ARCHIVE_PREFIX, runD1Retention } from "./d1-retention-archive";

const NOW = new Date("2026-10-21T12:00:00.000Z");
const DAY = 86_400;

class MemoryBucket {
	readonly objects = new Map<string, Uint8Array>();
	failPuts = false;
	async put(key: string, value: Uint8Array) {
		if (this.failPuts) throw new Error("r2 unavailable");
		this.objects.set(key, value);
		return { key };
	}
	async head(key: string) {
		const value = this.objects.get(key);
		return value ? { key, size: value.byteLength } : null;
	}
}

function fixture(policies: string) {
	const sqlite = new DatabaseSync(":memory:", {
		enableForeignKeyConstraints: false,
	});
	sqlite.exec(schemaDdl(auditEvents, tediRuntimeEvents, d1RetentionPolicies));
	sqlite.exec(
		`INSERT INTO d1_retention_policies(table_name, mode, keep_days, max_rows_per_run, updated_at) VALUES ${policies}`,
	);
	const insert = sqlite.prepare(
		"INSERT INTO audit_events(id, organization_id, actor_id, actor_type, action, resource_type, metadata, timestamp) VALUES(?,?,?,?,?,?,?,?)",
	);
	const nowSeconds = Math.floor(NOW.getTime() / 1000);
	const seed = (ages: number[]) =>
		ages.forEach((age, index) =>
			insert.run(
				`audit-${index}`,
				"fictional-lighthouse",
				"user-ada",
				"user",
				"mcp.tool.execute",
				"mcp_tool",
				JSON.stringify({ n: index }),
				nowSeconds - age * DAY,
			),
		);
	const count = () =>
		Number(
			(
				sqlite.prepare("SELECT count(*) AS n FROM audit_events").get() as {
					n: number;
				}
			).n,
		);
	const policy = (table: string) =>
		sqlite
			.prepare(
				"SELECT last_report AS report, archived_rows_total AS archived, deleted_rows_total AS deleted FROM d1_retention_policies WHERE table_name = ?",
			)
			.get(table) as { report: string; archived: number; deleted: number };
	return {
		db: createDbQueryClient(createD1Facade(sqlite)),
		seed,
		count,
		policy,
	};
}

async function gunzipLines(bytes: Uint8Array): Promise<string[]> {
	const text = await new Response(
		new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")),
	).text();
	return text.trim().split("\n");
}

describe("runD1Retention", () => {
	it("dry run reports what it would free and changes no rows", async () => {
		const { db, seed, count, policy } = fixture(
			"('audit_events','dry_run',30,2000,'2026-10-21')",
		);
		seed([...Array.from({ length: 120 }, () => 90), 1, 1]);
		const bucket = new MemoryBucket();
		const result = await runD1Retention({
			db,
			bucket: bucket as unknown as R2Bucket,
			now: NOW,
		});
		expect(count()).toBe(122);
		expect(bucket.objects.size).toBe(0);
		expect(result.tables[0]).toMatchObject({
			tableName: "audit_events",
			mode: "dry_run",
			eligibleRows: 120,
			deletedRows: 0,
		});
		expect(result.eligibleBytes).toBeGreaterThan(0);
		expect(JSON.parse(policy("audit_events").report)).toMatchObject({
			mode: "dry_run",
			eligibleRows: 120,
		});
	});

	it("archives expired rows to R2 before deleting exactly those rows", async () => {
		const { db, seed, count, policy } = fixture(
			"('audit_events','archive_then_delete',30,2000,'2026-10-21')",
		);
		seed([...Array.from({ length: 620 }, () => 90), 5, 2]);
		const bucket = new MemoryBucket();
		const result = await runD1Retention({
			db,
			bucket: bucket as unknown as R2Bucket,
			now: NOW,
		});
		expect(result.tables[0]).toMatchObject({
			archivedRows: 620,
			deletedRows: 620,
			objects: 2,
			stoppedBy: "done",
		});
		expect(count()).toBe(2);
		const keys = [...bucket.objects.keys()].sort();
		expect(keys[0]?.startsWith(`${D1_ARCHIVE_PREFIX}audit_events/`)).toBe(true);
		const archived = await Promise.all(
			keys.map((key) => gunzipLines(bucket.objects.get(key) as Uint8Array)),
		);
		const rows = archived.flat().map((line) => JSON.parse(line));
		expect(rows).toHaveLength(620);
		expect(rows[0]).toMatchObject({ id: "audit-0", __rowid: 1 });
		expect(policy("audit_events")).toMatchObject({
			archived: 620,
			deleted: 620,
		});
	});

	it("keeps rows when the archive write fails and resumes on the next run", async () => {
		const { db, seed, count } = fixture(
			"('audit_events','archive_then_delete',30,2000,'2026-10-21')",
		);
		seed(Array.from({ length: 60 }, () => 90));
		const bucket = new MemoryBucket();
		bucket.failPuts = true;
		const failed = await runD1Retention({
			db,
			bucket: bucket as unknown as R2Bucket,
			now: NOW,
		});
		expect(failed.tables[0]).toMatchObject({
			stoppedBy: "error",
			deletedRows: 0,
		});
		expect(count()).toBe(60);

		bucket.failPuts = false;
		await runD1Retention({
			db,
			bucket: bucket as unknown as R2Bucket,
			now: NOW,
		});
		expect(count()).toBe(0);
	});

	it("respects the per-run row cap", async () => {
		const { db, seed, count } = fixture(
			"('audit_events','archive_then_delete',30,120,'2026-10-21')",
		);
		seed(Array.from({ length: 300 }, () => 90));
		const result = await runD1Retention({
			db,
			bucket: new MemoryBucket() as unknown as R2Bucket,
			now: NOW,
		});
		expect(result.tables[0]).toMatchObject({
			deletedRows: 120,
			stoppedBy: "row_cap",
		});
		expect(count()).toBe(180);
	});

	it("refuses unsafe policies without touching rows", async () => {
		const { db, seed, count, policy } = fixture(
			"('audit_events','delete',90,2000,'2026-10-21'), ('organizations','delete',90,2000,'2026-10-21')",
		);
		seed(Array.from({ length: 10 }, () => 200));
		const result = await runD1Retention({ db, now: NOW });
		expect(result.tables.map((table) => table.problem)).toEqual([
			"archive_required",
			"unsupported_table",
		]);
		expect(count()).toBe(10);
		expect(JSON.parse(policy("audit_events").report)).toMatchObject({
			problem: "archive_required",
		});
	});
});
