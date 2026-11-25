import { afterEach, expect, test } from "vite-plus/test";
import { DatabaseSync } from "node:sqlite";
import { createD1Facade } from "../test/d1-facade";
import { gzipSync } from "node:zlib";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import {
	archiveSource,
	copyPages,
	keysetSource,
	loadCheckpoint,
	saveCheckpoint,
	verifyCopy,
	type CopyState,
	type CopyTable,
	type PgQuery,
} from "../../../../scripts/db/core-copy";

const table: CopyTable = {
	table: "copy_fixture",
	keys: ["id"],
	columns: {
		id: "value",
		organization_id: "value",
		payload: "json",
		active: "boolean",
		updated_at: "timestamp",
	},
};
const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	const d1 = createD1Facade(sqlite, { maxBoundParams: 100 });
	cleanup.push(() => sqlite.close());
	sqlite.exec(
		"CREATE TABLE copy_fixture (id TEXT PRIMARY KEY, organization_id TEXT, payload TEXT, active INTEGER, updated_at TEXT); CREATE INDEX copy_updated ON copy_fixture(updated_at)",
	);
	const engine = new PGlite();
	cleanup.push(() => engine.close());
	await engine.exec(
		"CREATE TABLE copy_fixture (id TEXT PRIMARY KEY, organization_id TEXT, payload JSONB, active BOOLEAN, updated_at TIMESTAMPTZ)",
	);
	let reads = 0,
		writes = 0;
	const plans: string[] = [];
	const source = (extra: Partial<Parameters<typeof keysetSource>[0]> = {}) =>
		keysetSource({
			id: "immutable-fixture-v1",
			table: table.table,
			highWater: 8,
			read: async (sql, params) => {
				reads++;
				plans.push(
					JSON.stringify(
						sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params),
					),
				);
				return (
					await d1
						.prepare(sql)
						.bind(...params)
						.all()
				).results as Record<string, unknown>[];
			},
			...extra,
		});
	const query: PgQuery = async (sql, params) => {
		if (sql.startsWith("INSERT")) writes++;
		return engine.query(sql, params);
	};
	const insert = (
		id: string,
		time = "2026-01-01T00:00:00Z",
		payload = '{"nested":{"a":1,"b":2}}',
	) =>
		sqlite
			.prepare("INSERT INTO copy_fixture VALUES (?, 'org_example', ?, 1, ?)")
			.run(id, payload, time);
	return {
		sqlite,
		engine,
		query,
		source,
		insert,
		plans,
		reads: () => reads,
		writes: () => writes,
	};
}

test("paced keyset copy resumes after checkpoint failure, upserts whole pages and verifies without source reads", async () => {
	const f = await fixture();
	for (let i = 1; i <= 5; i++) f.insert(`row-${i}`);
	const root = await mkdtemp(join(tmpdir(), "core-copy-"));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "checkpoint.json");
	const pauses: number[] = [];
	let saved = 0;
	const options = {
		table,
		source: f.source(),
		query: f.query,
		pageSize: 2,
		pauseMs: 25,
		wait: async (ms: number) => {
			pauses.push(ms);
		},
	};
	await expect(
		copyPages({
			...options,
			save: async (state) => {
				if (++saved === 2)
					throw new Error("power loss before checkpoint rename");
				await saveCheckpoint(path, state);
			},
		}),
	).rejects.toThrow("power loss");
	const checkpoint = await loadCheckpoint(path);
	expect(checkpoint.pages).toHaveLength(1);
	expect(checkpoint.cursor).toEqual({ rowid: 2 });
	const state = await copyPages({
		...options,
		state: checkpoint,
		save: (state) => saveCheckpoint(path, state),
	});
	expect(state.done).toBe(true);
	expect(state.pages.map((page) => page.keys.length)).toEqual([2, 2, 1]);
	expect(f.writes()).toBe(4); // Two first writes, replay of the uncheckpointed page, final page.
	expect(pauses).toEqual([25, 25, 25, 25, 25]);
	expect(f.plans.every((plan) => plan.includes("SEARCH"))).toBe(true);
	const reads = f.reads();
	await verifyCopy(table, f.query, state);
	expect(f.reads()).toBe(reads);
	await f.engine.exec(
		"UPDATE copy_fixture SET payload = '{\"corrupted\":true}' WHERE id = 'row-3'",
	);
	await expect(verifyCopy(table, f.query, state)).rejects.toThrow(
		"verification checksum",
	);
	expect(checkpoint.pages).toHaveLength(1); // Failed save cannot mutate the durable state.
});

test("delta includes timestamp ties and updates old rowids; hot copy excludes old history", async () => {
	const f = await fixture();
	f.insert("old", "2025-01-01T00:00:00Z");
	f.insert("first", "2026-01-01T00:00:00Z");
	f.insert("tie", "2026-01-01T00:00:00Z");
	f.insert("later", "2026-03-01T00:00:00Z");
	const base = {
		table,
		query: f.query,
		pageSize: 1,
		pauseMs: 0,
		save: async (_state: CopyState) => {},
	};
	await copyPages({
		...base,
		source: f.source({
			hot: { column: "updated_at", from: "2026-01-01T00:00:00Z" },
		}),
	});
	expect(
		(await f.engine.query("SELECT id FROM copy_fixture ORDER BY id")).rows,
	).toEqual([{ id: "first" }, { id: "later" }, { id: "tie" }]);
	f.sqlite.exec(
		"UPDATE copy_fixture SET updated_at = '2026-02-01T00:00:00Z', payload = '\"changed\"' WHERE id = 'old'",
	);
	const state = await copyPages({
		...base,
		source: f.source({
			delta: {
				column: "updated_at",
				after: "2026-01-01T00:00:00Z",
				through: "2026-02-01T00:00:00Z",
			},
		}),
	});
	expect(state.pages.flatMap((page) => page.keys.map((key) => key.id))).toEqual(
		["first", "tie", "old"],
	);
	await verifyCopy(table, f.query, state);
	expect(
		(await f.engine.query("SELECT payload FROM copy_fixture WHERE id = 'old'"))
			.rows,
	).toEqual([{ payload: "changed" }]);
});

test("rowid-only delta handles append-only tables and rejects a changed resume window", async () => {
	const f = await fixture();
	f.insert("one");
	const state = await copyPages({
		table,
		source: f.source(),
		query: f.query,
		pauseMs: 0,
		save: async () => {},
	});
	f.insert("two");
	const delta = await copyPages({
		table,
		source: f.source({ afterRowid: Number(state.cursor!.rowid) }),
		query: f.query,
		pauseMs: 0,
		save: async () => {},
	});
	expect(delta.pages.flatMap((page) => page.keys)).toEqual([{ id: "two" }]);
	await expect(
		copyPages({
			table,
			source: f.source({ highWater: 9 }),
			query: f.query,
			state,
			save: async () => {},
		}),
	).rejects.toThrow("different copy plan");
	await f.engine.exec("DELETE FROM copy_fixture WHERE id = 'one'");
	await expect(
		copyPages({
			table,
			source: f.source(),
			query: f.query,
			state,
			save: async () => {},
		}),
	).rejects.toThrow("verification checksum");
});

test("EU archive resumes inside a compressed object and lists forward without D1", async () => {
	const f = await fixture();
	const prefix = "d1-archive/v1/copy_fixture/org_example/";
	const keys = [
		prefix + "2025-01-01/1-3.ndjson.gz",
		prefix + "2025-01-02/4-4.ndjson.gz",
	];
	const row = (id: string) => ({
		id,
		organization_id: "org_example",
		payload: { text: "snow 雪" },
		active: true,
		updated_at: "2025-01-01T00:00:00Z",
		__rowid: 7,
	});
	const objects = new Map([
		[
			keys[0]!,
			gzipSync(
				[row("one"), row("two"), row("three")]
					.map((value) => JSON.stringify(value))
					.join("\n"),
			),
		],
		[keys[1]!, gzipSync(JSON.stringify(row("four")))],
	]);
	const source = archiveSource({
		id: "eu-capture-v1",
		endpoint: `https://${"a".repeat(32)}.eu.r2.cloudflarestorage.com`,
		table: table.table,
		organization: "org_example",
		nextKey: async (_prefix, after) => keys.find((key) => key > after) ?? null,
		get: async (key) => objects.get(key)!,
	});
	let state: CopyState | undefined;
	let saves = 0;
	const base = { table, source, query: f.query, pageSize: 2, pauseMs: 0 };
	await expect(
		copyPages({
			...base,
			save: async (value) => {
				if (++saves === 2) throw new Error("interrupted");
				state = value;
			},
		}),
	).rejects.toThrow("interrupted");
	expect(state?.cursor).toEqual({ key: keys[0], offset: 2 });
	state = await copyPages({ ...base, state, save: async () => {} });
	await verifyCopy(table, f.query, state);
	expect(state.pages.flatMap((page) => page.keys)).toHaveLength(4);
	expect(f.reads()).toBe(0);
	expect(() =>
		archiveSource({
			id: "bad",
			endpoint: "https://example.com",
			table: table.table,
			organization: "org_example",
			nextKey: async () => null,
			get: async () => new Uint8Array(),
		}),
	).toThrow("EU R2");
});

test("bad source pages and target coercion never advance the checkpoint", async () => {
	const f = await fixture();
	f.insert("one");
	await f.engine.exec(
		"CREATE FUNCTION alter_copy() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.payload = '{}'::jsonb; RETURN NEW; END $$; CREATE TRIGGER alter_copy BEFORE INSERT ON copy_fixture FOR EACH ROW EXECUTE FUNCTION alter_copy()",
	);
	let saves = 0;
	await expect(
		copyPages({
			table,
			source: f.source(),
			query: f.query,
			pauseMs: 0,
			save: async () => {
				saves++;
			},
		}),
	).rejects.toThrow("Copied page checksum");
	expect(saves).toBe(0);
	await expect(
		copyPages({
			table,
			source: {
				id: "stuck",
				page: async (cursor) => ({ rows: [{}], next: cursor }),
			},
			query: f.query,
			pauseMs: 0,
			save: async () => {
				saves++;
			},
		}),
	).rejects.toThrow("cursor did not advance");
	expect(saves).toBe(0);
});

test("a constraint failure rolls back the whole copied page", async () => {
	const f = await fixture();
	f.insert("valid");
	f.insert("forbidden");
	await f.engine.exec("ALTER TABLE copy_fixture ADD CHECK (id <> 'forbidden')");
	let saves = 0;
	await expect(
		copyPages({
			table,
			source: f.source(),
			query: f.query,
			pauseMs: 0,
			save: async () => {
				saves++;
			},
		}),
	).rejects.toThrow();
	expect(saves).toBe(0);
	expect((await f.engine.query("SELECT id FROM copy_fixture")).rows).toEqual(
		[],
	);
});

test("archive rejects corrupted retention objects and tenant mismatches", async () => {
	const prefix = "d1-archive/v1/copy_fixture/org_example/";
	const bytes = gzipSync(JSON.stringify({ organization_id: "org_other" }));
	const options = {
		id: "archive-fixture",
		endpoint: `https://${"a".repeat(32)}.eu.r2.cloudflarestorage.com`,
		table: table.table,
		organization: "org_example",
		get: async () => bytes,
	};
	const corrupt = archiveSource({
		...options,
		nextKey: async () => prefix + `2025-01-01/1-1-${"0".repeat(64)}.ndjson.gz`,
	});
	await expect(corrupt.page(null, 1)).rejects.toThrow(
		"object checksum mismatch",
	);
	const wrongTenant = archiveSource({
		...options,
		nextKey: async () => prefix + "2025-01-01/1-1.ndjson.gz",
	});
	await expect(wrongTenant.page(null, 1)).rejects.toThrow(
		"organization mismatch",
	);
});

test("wide core rows avoid the Postgres function argument limit and normalize epoch timestamps", async () => {
	const f = await fixture();
	const columns: CopyTable["columns"] = {
		...table.columns,
		updated_at: "epoch",
	};
	for (let i = 0; i < 60; i++) {
		const column = `extra_${i}`;
		columns[column] = "value";
		f.sqlite.exec(
			`ALTER TABLE copy_fixture ADD COLUMN ${column} TEXT DEFAULT 'example'`,
		);
	}
	await f.engine.exec(
		Array.from(
			{ length: 60 },
			(_, i) => `ALTER TABLE copy_fixture ADD COLUMN extra_${i} TEXT`,
		).join(";") +
			"; ALTER TABLE copy_fixture ADD COLUMN generated_value TEXT GENERATED ALWAYS AS (id || '-generated') STORED",
	);
	f.sqlite.exec(
		"INSERT INTO copy_fixture (id, organization_id, payload, active, updated_at) VALUES ('wide', 'org_example', '{\"key\":null}', 0, '1767225600')",
	);
	const wide = { ...table, columns };
	const state = await copyPages({
		table: wide,
		source: f.source(),
		query: f.query,
		pauseMs: 0,
		save: async () => {},
	});
	await verifyCopy(wide, f.query, state);
	expect(
		(
			await f.engine.query(
				"SELECT active, generated_value, updated_at FROM copy_fixture",
			)
		).rows,
	).toEqual([
		{
			active: false,
			generated_value: "wide-generated",
			updated_at: new Date("2026-01-01T00:00:00Z"),
		},
	]);
});
