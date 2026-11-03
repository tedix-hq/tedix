import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "./d1-facade";
import { readD1StorageReport } from "../queries/d1-size";

function fixture(
	stats?: Record<string, number>,
	probeError = "no such table: dbstat",
) {
	const sqlite = new DatabaseSync(":memory:");
	const native = createD1Facade(sqlite);
	const statements: string[] = [];
	const binding = new Proxy(native, {
		get(target, key) {
			if (key !== "prepare") return Reflect.get(target, key);
			return (query: string) => {
				statements.push(query);
				if (!query.includes("FROM dbstat")) return target.prepare(query);
				if (!stats) throw new Error(probeError);
				const statement = (params: unknown[]) => ({
					bind: (...values: unknown[]) => statement(values),
					all: async () => ({
						success: true,
						results: query.includes("AS bytes")
							? stats[String(params[0])] === undefined
								? []
								: [{ bytes: stats[String(params[0])] }]
							: [{ name: "sqlite_schema", pgsize: stats.sqlite_schema }],
					}),
				});
				return statement([]);
			};
		},
	});
	return { sqlite, db: createDbQueryClient(binding), statements };
}

describe("D1 storage inventory", () => {
	it("uses dbstat page bytes for tables, indexes, and schema without reading rows", async () => {
		const { sqlite, db, statements } = fixture({
			sqlite_schema: 4096,
			sample: 8192,
			sample_value: 4096,
		});
		sqlite.exec(
			"CREATE TABLE sample (value TEXT); CREATE INDEX sample_value ON sample(value)",
		);
		const report = await readD1StorageReport(db);
		expect(report.method).toBe("dbstat");
		expect(report.complete).toBe(true);
		expect(report.attributedBytes).toBe(16384);
		expect(report.objects.find((o) => o.name === "sample_value")).toMatchObject(
			{ table: "sample", type: "index", bytes: 4096 },
		);
		expect(statements.some((q) => q.includes('FROM "sample"'))).toBe(false);
	});

	it("counts sparse rowids in keyset pages and samples UTF-8, NUL and blob byte lengths", async () => {
		const { sqlite, db, statements } = fixture();
		sqlite.exec(
			"CREATE TABLE sample (label TEXT, body BLOB); CREATE INDEX sample_label ON sample(label)",
		);
		for (const rowid of [-7, 0, 12, 100, 500]) {
			sqlite
				.prepare("INSERT INTO sample(rowid,label,body) VALUES (?, ?, ?)")
				.run(rowid, "é\0z", new Uint8Array([1, 2, 3]));
		}
		const report = await readD1StorageReport(db, {
			pageSize: 2,
			sampleSize: 1,
		});
		expect(report.method).toBe("estimate");
		expect(report.objects.find((o) => o.name === "sample")).toMatchObject({
			rows: 5,
			sampledRows: 3,
			bytes: 35,
		});
		expect(report.objects.find((o) => o.name === "sample_label")).toMatchObject(
			{ rows: 5, bytes: 60 },
		);
		expect(
			statements
				.filter((q) => q.includes('FROM "sample"'))
				.every((q) => /LIMIT \?/.test(q)),
		).toBe(true);
		expect(
			statements.some((q) =>
				/\b(?:INSERT|UPDATE|DELETE|CREATE|ANALYZE)\b/i.test(q),
			),
		).toBe(false);
	});

	it("supports composite WITHOUT ROWID cursors and quotes schema identifiers", async () => {
		const { sqlite, db } = fixture();
		sqlite.exec(
			'CREATE TABLE "odd""name" (a TEXT, b INTEGER, c TEXT, PRIMARY KEY(a,b)) WITHOUT ROWID; CREATE INDEX lookup ON "odd""name"(c)',
		);
		for (const [a, b] of [
			["x", 1],
			["x", 2],
			["y", 1],
		] as const)
			sqlite.prepare('INSERT INTO "odd""name" VALUES (?, ?, ?)').run(a, b, "z");
		const report = await readD1StorageReport(db, {
			pageSize: 1,
			sampleSize: 1,
		});
		expect(report.objects.find((o) => o.type === "table")).toMatchObject({
			rows: 3,
			sampledRows: 3,
			bytes: 9,
		});
		expect(report.objects.find((o) => o.name === "lookup")).toMatchObject({
			bytes: 9,
		});
	});

	it("samples partial predicates and nested index expressions without counting excluded rows", async () => {
		const { sqlite, db } = fixture();
		sqlite.exec(
			"CREATE TABLE sample (value TEXT); CREATE INDEX expr ON sample(lower(substr(value,1,2)) DESC); CREATE INDEX partial ON sample(value) WHERE coalesce(length(value),0) > 0; INSERT INTO sample VALUES ('abc'), (NULL)",
		);
		const report = await readD1StorageReport(db);
		expect(report.complete).toBe(true);
		expect(report.objects.find((o) => o.name === "expr")).toMatchObject({
			rows: 2,
			bytes: 18,
		});
		expect(report.objects.find((o) => o.name === "partial")).toMatchObject({
			rows: 1,
			bytes: 11,
		});
	});

	it("checkpoints complete table/index groups with bounded parallel tables", async () => {
		const { sqlite, db } = fixture();
		sqlite.exec(
			"CREATE TABLE first(value TEXT); CREATE INDEX first_value ON first(value); INSERT INTO first VALUES ('abc'); CREATE TABLE second(value TEXT); INSERT INTO second VALUES ('xy')",
		);
		const checkpoints: string[][] = [];
		const report = await readD1StorageReport(db, {
			concurrency: 4,
			onTable: (objects) => {
				checkpoints.push(objects.map((o) => o.name));
			},
		});
		expect(report.complete).toBe(true);
		expect(report.attributedBytes).toBe(16);
		expect(checkpoints.map((group) => group.sort()).sort()).toEqual([
			["first", "first_value"],
			["second"],
		]);
		await expect(readD1StorageReport(db, { concurrency: 5 })).rejects.toThrow(
			"Invalid",
		);
	});

	it("stops at the query budget and does not treat provider failures as absent dbstat", async () => {
		const f = fixture();
		f.sqlite.exec(
			"CREATE TABLE sample (value TEXT); INSERT INTO sample VALUES ('x'), ('y')",
		);
		await expect(readD1StorageReport(f.db, { maxPages: 1 })).rejects.toThrow(
			"budget exhausted",
		);
		const failed = fixture(undefined, "D1_ERROR: overloaded");
		await expect(readD1StorageReport(failed.db)).rejects.toThrow("overloaded");
		expect(failed.statements.some((q) => q.includes("sqlite_master"))).toBe(
			false,
		);
		await expect(readD1StorageReport(f.db, { pageSize: 0 })).rejects.toThrow(
			"Invalid",
		);
	});
});
