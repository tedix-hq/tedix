import { describe, expect, test } from "vite-plus/test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import type { PgQuery } from "../../../scripts/db/core-copy.ts";
import {
	applySchema,
	copyTable,
	copyStatus,
	verifyTable,
	type CopyPorts,
} from "./copy.ts";
import { coreCopyPlan, planTable } from "./plan.ts";
import { ProgressStore, type CheckpointStore } from "./store.ts";
import {
	buildCoreCopyPlan,
	coreCopyPlanSource,
} from "../scripts/generate-plan.ts";
import { coreCopyMigrationSource } from "../scripts/generate-migrations.ts";
import { CORE_COPY_MIGRATIONS } from "./migrations.generated.ts";

function memoryStore(): CheckpointStore {
	const map = new Map<string, string>();
	return {
		get: async (key) => map.get(key) ?? null,
		put: async (key, value) => {
			map.set(key, value);
		},
	};
}

const noWait = () => Promise.resolve();

function pgliteQuery(engine: PGlite): PgQuery {
	return async (sql, params) => {
		if (params.length === 0) {
			// Simple protocol like postgres.js sql.unsafe(text): accepts chunks
			// holding several statements and keeps one session's transaction
			// state across BEGIN/COMMIT migration files.
			const results = await engine.exec(sql);
			const last = results[results.length - 1];
			return { rows: (last?.rows ?? []) as Record<string, unknown>[] };
		}
		const result = await engine.query(sql, params as never[]);
		return { rows: result.rows as Record<string, unknown>[] };
	};
}

/** organizations: 12 plan columns, two json kinds, one bigint. */
function seedSource(rowCount: number) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`CREATE TABLE organizations (
		id TEXT PRIMARY KEY,
		name TEXT,
		slug TEXT,
		type TEXT,
		descope_tenant_id TEXT,
		logo_url TEXT,
		description TEXT,
		apps_count INTEGER,
		features TEXT,
		metadata TEXT,
		created_at TEXT,
		updated_at TEXT
	)`);
	const insert = sqlite.prepare(
		`INSERT INTO organizations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	for (let i = 1; i <= rowCount; i += 1) {
		insert.run(
			`org-${i}`,
			`Org ${i}`,
			`org-${i}`,
			"team",
			`tenant-${i}`,
			null,
			`description ${i}`,
			i,
			`{"plan":"pro","seat":${i % 7}}`,
			`{"source":"test"}`,
			"2026-01-01T00:00:00.000Z",
			"2026-01-02T00:00:00.000Z",
		);
	}
	return sqlite;
}

async function targetSchema(engine: PGlite) {
	await engine.exec(`CREATE TABLE organizations (
		id text PRIMARY KEY,
		name text,
		slug text,
		type text,
		descope_tenant_id text,
		logo_url text,
		description text,
		apps_count bigint,
		features jsonb,
		metadata jsonb,
		created_at text,
		updated_at text
	)`);
}

function d1Port(sqlite: DatabaseSync, failOnPrepare?: number) {
	let prepares = 0;
	const db = createD1Facade(sqlite, {
		onPrepare: () => {
			prepares += 1;
			if (failOnPrepare !== undefined && prepares === failOnPrepare)
				throw new Error("D1_ERROR: D1 database is overloaded");
		},
	});
	return {
		readD1: async (sql: string, params: (string | number | null)[]) => {
			const result = await db
				.prepare(sql)
				.bind(...params)
				.all();
			return result.results as Record<string, unknown>[];
		},
		prepareCount: () => prepares,
	};
}

describe("core-copy worker", () => {
	test("generated plan and migrations match the source schemas", async () => {
		const plan = await buildCoreCopyPlan();
		expect(coreCopyPlanSource(plan)).toBe(
			readFileSync(
				fileURLToPath(new URL("./plan.generated.ts", import.meta.url)),
				"utf8",
			),
		);
		expect(coreCopyMigrationSource()).toBe(
			readFileSync(
				fileURLToPath(new URL("./migrations.generated.ts", import.meta.url)),
				"utf8",
			),
		);
		expect(CORE_COPY_MIGRATIONS.length).toBeGreaterThan(0);
	});

	test("plan skips the cutover-excluded tables and keeps keys in columns", () => {
		const names = new Set(coreCopyPlan().map((entry) => entry.table));
		expect(names.has("cms_restore_permits")).toBe(false);
		expect(names.has("cms_restore_fences")).toBe(false);
		for (const entry of coreCopyPlan()) {
			expect(entry.keys.length).toBeGreaterThan(0);
			for (const key of entry.keys) expect(entry.columns).toHaveProperty(key);
		}
		expect(planTable("organizations")?.columns.features).toBe("json");
	});

	test("applySchema is idempotent and records every migration", async () => {
		const engine = new PGlite();
		try {
			const query = pgliteQuery(engine);
			const first = await applySchema(query);
			expect(first.applied).toHaveLength(CORE_COPY_MIGRATIONS.length);
			const second = await applySchema(query);
			expect(second.applied).toHaveLength(0);
			expect(second.alreadyApplied).toBe(CORE_COPY_MIGRATIONS.length);
			const ledger = await engine.query(
				`SELECT count(*)::int AS n FROM core_copy_migrations`,
			);
			expect((ledger.rows[0] as { n: number }).n).toBe(
				CORE_COPY_MIGRATIONS.length,
			);
		} finally {
			await engine.close();
		}
	});

	test("copy resumes from its checkpoint after a D1 overload", async () => {
		const sqlite = seedSource(1100);
		const engine = new PGlite();
		try {
			await targetSchema(engine);
			// Prepare #1 is the high-water probe, #2 the first page read; fail
			// the second page read so exactly one page is checkpointed.
			const source = d1Port(sqlite, 3);
			const store = new ProgressStore(memoryStore());
			const ports: CopyPorts = {
				readD1: source.readD1,
				query: pgliteQuery(engine),
				store,
				wait: noWait,
			};

			const first = await copyTable(ports, "organizations");
			expect(first.status).toBe("paused");
			expect(first.done).toBe(false);
			const mid = await engine.query(
				`SELECT count(*)::int AS n FROM organizations`,
			);
			expect((mid.rows[0] as { n: number }).n).toBe(500);
			// The run stays on; the next tick resumes the paused table.
			expect((await store.runState()).mode).toBe("running");

			// Resume with a healthy D1: the checkpoint continues at page 2.
			const resumed = d1Port(sqlite);
			const second = await copyTable(
				{ ...ports, readD1: resumed.readD1 },
				"organizations",
			);
			expect(second.done).toBe(true);
			const done = await engine.query(
				`SELECT count(*)::int AS n FROM organizations`,
			);
			expect((done.rows[0] as { n: number }).n).toBe(1100);

			const verify = await verifyTable(
				{ ...ports, readD1: resumed.readD1 },
				"organizations",
			);
			expect(verify.verified).toBe(true);
			const status = await copyStatus({
				...ports,
				readD1: resumed.readD1,
			});
			const row = status.tables.find((t) => t.table === "organizations");
			expect(row?.status).toBe("verified");
		} finally {
			await engine.close();
			sqlite.close();
		}
	});
});
