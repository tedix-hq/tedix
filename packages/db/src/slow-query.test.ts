import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createDbClient, createDbSession } from "./client";
import { createDbQueryClient } from "./query-client";
import { observeD1 } from "./slow-query";
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
			expect(await statement[method]()).toBe(result);
			expect(database.prepare).toHaveBeenCalledWith(sql);
			expect(native.bind).toHaveBeenCalledWith("private-binding");
			expect(log).toHaveBeenCalledOnce();
			const event = log.mock.calls[0][0];
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
		expect(log.mock.calls[0][0]).toMatchObject({
			durationMs: 1_500,
			durationSource: "d1",
			rowsRead: 500,
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
