import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createDbClient, createDbSession } from "./client";
import { createDbQueryClient } from "./query-client";
import { observeD1, withD1Ledger } from "./slow-query";
import { createD1Facade } from "./test/d1-facade";
import { createMigratedSqlite } from "./test/migrated-sqlite";

function fixture(duration = 1_001) {
	let clock = 0;
	vi.spyOn(performance, "now").mockImplementation(() => clock);
	const log = vi.spyOn(console, "warn").mockImplementation(() => {});
	const result = {
		results: [{ value: 7 }],
		success: true,
		meta: { rows_read: 500, duration },
	};
	const execute = vi.fn(async () => {
		clock += duration;
		return result;
	});
	const native = {
		bind: vi.fn(() => native),
		all: execute,
		run: execute,
		raw: execute,
		first: execute,
	};
	const database = {
		prepare: vi.fn(() => native),
		batch: vi.fn(async (batch: unknown[]) => {
			expect(batch).toEqual([native]);
			clock += duration;
			return [result];
		}),
	};
	return {
		db: observeD1(database as unknown as D1Database),
		database,
		native,
		result,
		log,
	};
}

afterEach(() => vi.restoreAllMocks());

describe("slow D1 observation", () => {
	it.each(["all", "run", "raw", "first"] as const)(
		"preserves %s results and omits values",
		async (method) => {
			const { db, database, native, result, log } = fixture();
			const sql = `SELECT "value" FROM "items" WHERE id = ? AND value = 'private''literal' AND n = 123 /* private comment */`;
			const statement = db.prepare(sql).bind("private-binding");
			const observed =
				method === "all"
					? await statement.all()
					: method === "run"
						? await statement.run()
						: method === "raw"
							? await statement.raw()
							: await statement.first();
			expect(observed).toBe(result);
			expect(database.prepare).toHaveBeenCalledWith(sql);
			expect(native.bind).toHaveBeenCalledWith("private-binding");
			expect(log).toHaveBeenCalledOnce();
			const event = log.mock.calls.at(0)![0];
			expect(event).toMatchObject({
				event: "db.query.slow",
				sampleRate: 1,
				durationMs: 1_001,
				durationSource: "wall",
				operation: method,
			});
			expect(event.caller).toContain("slow-query.test.ts");
			expect(event.sqlShape).toContain('SELECT "value" FROM "items"');
			expect(JSON.stringify(event)).not.toMatch(/private|123/);
		},
	);

	it.each([0, 999, 1_000])("does not log %s ms", async (duration) => {
		const { db, log } = fixture(duration);
		await db.prepare("SELECT ?").bind(7).all();
		expect(log).not.toHaveBeenCalled();
	});

	it("logs every slow execution, including repeated queries", async () => {
		const { db, log } = fixture();
		const statement = db.prepare("SELECT ?").bind(7);
		await statement.all();
		await statement.all();
		expect(log).toHaveBeenCalledTimes(2);
		expect(observeD1(db)).toBe(db);
	});

	it("passes native statements to batches and records D1 duration and rows read", async () => {
		const { db, result, log } = fixture(1_500);
		expect(await db.batch([db.prepare("SELECT ?").bind(7)])).toEqual([result]);
		expect(log).toHaveBeenCalledOnce();
		expect(log.mock.calls.at(0)![0]).toMatchObject({
			durationMs: 1_500,
			durationSource: "d1",
			rowsRead: 500,
		});
	});

	it("identifies a large read without a statement duration and preserves its result", async () => {
		const { db, database, result, log } = fixture(5);
		const large = { ...result, meta: { rows_read: 687_203 } };
		database.batch.mockImplementation(async () => [result, large] as never);
		expect(
			await db.batch([
				db.prepare("SELECT 1"),
				db.prepare('SELECT ? FROM "items"').bind("private-binding"),
			]),
		).toEqual([result, large]);
		expect(log).toHaveBeenCalledOnce();
		expect(log.mock.calls.at(0)![0]).toMatchObject({
			event: "db.query.large_read",
			sqlShape: 'SELECT ? FROM "items"',
			rowsRead: 687_203,
			durationSource: "unavailable",
		});
		expect(JSON.stringify(log.mock.calls)).not.toContain("private-binding");
	});

	it("reports a batch without per-statement durations once, not once per statement", async () => {
		const { db, database, log } = fixture(1_500);
		database.batch.mockImplementation(async (batch: unknown[]) => {
			vi.mocked(performance.now).mockReturnValue(1_500);
			return batch.map(() => ({ success: true, meta: {} })) as never;
		});
		await db.batch([
			db.prepare("INSERT INTO a VALUES (?)").bind(1),
			db.prepare("INSERT INTO b VALUES (?)").bind(2),
			db.prepare("INSERT INTO b VALUES (?)").bind(3),
		]);
		expect(log).toHaveBeenCalledOnce();
		expect(log.mock.calls.at(0)![0]).toMatchObject({
			sqlShape: "INSERT INTO a VALUES (?)",
			durationMs: 1_500,
			durationSource: "batch_wall",
			statementCount: 3,
		});
	});

	it("keeps the original rejection and omits its potentially sensitive message", async () => {
		const { db, native, log } = fixture();
		const error = new Error("private-binding");
		native.all.mockImplementationOnce(async () => {
			vi.mocked(performance.now).mockReturnValue(2_000);
			throw error;
		});
		await expect(
			db.prepare("SELECT ?").bind("private-binding").all(),
		).rejects.toBe(error);
		expect(log).toHaveBeenCalledOnce();
		expect(JSON.stringify(log.mock.calls)).not.toContain("private-binding");
	});

	it("does not let a logging failure replace a query result", async () => {
		const { db, result, log } = fixture();
		log.mockImplementation(() => {
			throw new Error("sink unavailable");
		});
		expect(await db.prepare("SELECT ?").bind(7).all()).toBe(result);
	});

	it("leaves a migrated hot lookup indexed through every factory", async () => {
		const sqlite = createMigratedSqlite();
		const sql = "SELECT id FROM organizations WHERE id = ?";
		const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("org-fixture");
		expect(plan).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					detail: expect.stringContaining("SEARCH organizations USING"),
				}),
			]),
		);
		expect(JSON.stringify(plan)).not.toContain("SCAN");
		const binding = createD1Facade(sqlite);
		const expected = await binding.prepare(sql).bind("org-fixture").all();
		for (const db of [
			createDbClient(binding),
			createDbQueryClient(binding),
			createDbSession(binding).db,
		]) {
			expect(await db.$client.prepare(sql).bind("org-fixture").all()).toEqual(
				expected,
			);
		}
	});
});

describe("per-request D1 ledger", () => {
	it("caps a 244-call fan-out across clients and releases permits after errors", async () => {
		const { db, native, database, result } = fixture(0);
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		let active = 0;
		let peak = 0;
		let calls = 0;
		const failure = new Error("D1 failed");
		const execute = async () => {
			active += 1;
			peak = Math.max(peak, active);
			const call = calls++;
			try {
				await new Promise((resolve) => setTimeout(resolve, 0));
				if (call === 0) throw failure;
				return result;
			} finally {
				active -= 1;
			}
		};
		for (const method of ["all", "run", "raw", "first"] as const)
			native[method].mockImplementation(execute);
		database.batch.mockImplementation(async () => [await execute()]);
		const otherClient = observeD1({ ...database } as unknown as D1Database);
		const outcomes = await withD1Ledger(
			"cron maintenance",
			() =>
				Promise.allSettled(
					Array.from({ length: 244 }, (_, index) => {
						const client = index % 2 ? db : otherClient;
						const statement = client.prepare("SELECT 1");
						if (index % 5 === 0) return client.batch([statement]);
						const method = (["all", "run", "raw", "first"] as const)[
							index % 4
						]!;
						if (method === "first") return statement.first();
						if (method === "raw") return statement.raw();
						if (method === "run") return statement.run();
						return statement.all();
					}),
				),
			{ maxInFlight: 6 },
		);
		expect(peak).toBe(6);
		expect(active).toBe(0);
		expect(outcomes.filter((outcome) => outcome.status === "rejected")).toEqual(
			[{ status: "rejected", reason: failure }],
		);
		expect(info.mock.calls[0]![0]).toMatchObject({
			statements: 244,
			maxInFlight: 6,
		});
	});

	it("finds a large read after many shapes even when it is not the slowest shape", async () => {
		const { db, result } = fixture(30);
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		await withD1Ledger("cron example", async () => {
			result.meta.rows_read = 1;
			for (let i = 0; i < 60; i++)
				await db.prepare(`SELECT "column_${i}"`).all();
			for (let i = 0; i < 10; i++) await db.prepare('SELECT "column_0"').all();
			result.meta.rows_read = 80_000;
			await db.prepare('SELECT "large_read"').all();
		});
		const line = info.mock.calls[0]![0] as Record<string, unknown>;
		expect(String(line.topReadShapes)).toMatch(
			/^1x 80000read 1returned SELECT "large_read"/,
		);
		expect(String(line.topShapes)).toMatch(
			/^11x 330ms 11rows SELECT "column_0"/,
		);
	});
	it("summarizes a request's statements once it crosses a threshold", async () => {
		const { db } = fixture(30);
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		await withD1Ledger("POST /rpc/example", async () => {
			for (let i = 0; i < 25; i++)
				await db.prepare("SELECT 1 WHERE id = 'secret'").all();
		});
		await withD1Ledger("GET /quiet", async () => {
			await db.prepare("SELECT 1").raw();
		});
		const lines = info.mock.calls.map(
			([line]) => line as Record<string, unknown>,
		);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({
			event: "db.request",
			label: "POST /rpc/example",
			statements: 25,
			d1WallMs: 750,
			rowsReturned: 25,
		});
		expect(String(lines[0]!.topShapes)).toContain("25x 750ms");
		expect(String(lines[0]!.topShapes)).not.toContain("secret");
		expect(String(lines[0]!.topReadShapes)).toContain(
			"25x 12500read 25returned",
		);
		expect(String(lines[0]!.topReadShapes)).not.toContain("secret");
	});
});
