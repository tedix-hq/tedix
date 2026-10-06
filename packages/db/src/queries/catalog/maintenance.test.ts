import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../../client";
import { createD1Facade } from "../../test/d1-facade";
import {
	deleteOldCatalogChanges,
	deleteOldCronExecutions,
	deleteOldKernelRuntimeEvents,
	deleteOldTediRuntimeEvents,
} from "./maintenance";

/**
 * Batched runtime-event retention against a REAL in-memory SQLite engine via
 * the production `createDbClient` path (flywheel-cron-darkness.test.ts pattern).
 *
 * Contract under test (P0 — 317d72f0):
 * - only rows with `created_at < now - days` are deleted; newer rows survive;
 * - the `DELETE ... WHERE id IN (SELECT id ... LIMIT n)` idiom drains a backlog
 *   across multiple batches and returns the true total deleted;
 * - pruning `kernel_runtime_events` never touches the durable
 *   `kernel_conversations` sidebar projection.
 */

function realDb(): { db: DbClient; sqlite: DatabaseSync } {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE tedi_runtime_events (
			id TEXT PRIMARY KEY NOT NULL,
			organization_id TEXT NOT NULL,
			tedi_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
		CREATE TABLE kernel_runtime_events (
			id TEXT PRIMARY KEY NOT NULL,
			organization_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			conversation_id TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
		CREATE TABLE kernel_conversations (
			id TEXT PRIMARY KEY NOT NULL,
			organization_id TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
		CREATE TABLE tedi_cron_executions (
			id TEXT PRIMARY KEY NOT NULL,
			created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
		);
		CREATE TABLE app_catalog_changes (
			id TEXT PRIMARY KEY NOT NULL,
			catalog_app_id TEXT NOT NULL,
			change_type TEXT NOT NULL,
			detected_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
		);
	`);
	return { db: createDbClient(createD1Facade(sqlite)), sqlite };
}

const OLD = "2020-01-01T00:00:00.000Z"; // far older than any 90d cutoff
const NEW = new Date().toISOString(); // within the 90d window

function seedTedi(sqlite: DatabaseSync, id: string, createdAt: string) {
	sqlite
		.prepare(
			`INSERT INTO tedi_runtime_events (id, organization_id, tedi_id, kind, created_at) VALUES (?, 'org1', 'tedi1', 'tool.completed', ?)`,
		)
		.run(id, createdAt);
}

function seedKernel(sqlite: DatabaseSync, id: string, createdAt: string) {
	sqlite
		.prepare(
			`INSERT INTO kernel_runtime_events (id, organization_id, kind, conversation_id, created_at) VALUES (?, 'org1', 'message.delta', 'conv1', ?)`,
		)
		.run(id, createdAt);
}

describe("deleteOldTediRuntimeEvents", () => {
	it("deletes only rows older than the cutoff; newer rows survive", async () => {
		const { db, sqlite } = realDb();
		seedTedi(sqlite, "old-1", OLD);
		seedTedi(sqlite, "old-2", OLD);
		seedTedi(sqlite, "new-1", NEW);

		const deleted = await deleteOldTediRuntimeEvents(db, 90);
		expect(deleted).toBe(2);

		const survivors = sqlite
			.prepare(`SELECT id FROM tedi_runtime_events ORDER BY id`)
			.all() as Array<{ id: string }>;
		expect(survivors.map((r) => r.id)).toEqual(["new-1"]);
	});

	it("drains a backlog across multiple batches (id-IN-subquery idiom)", async () => {
		const { db, sqlite } = realDb();
		for (let i = 0; i < 5; i++) seedTedi(sqlite, `old-${i}`, OLD);
		seedTedi(sqlite, "new-1", NEW);

		// batchSize 2 → 3 batches (2 + 2 + 1) drain all 5 old rows.
		const deleted = await deleteOldTediRuntimeEvents(db, 90, 2, 40);
		expect(deleted).toBe(5);

		const remaining = sqlite
			.prepare(`SELECT COUNT(*) AS c FROM tedi_runtime_events`)
			.get() as {
			c: number;
		};
		expect(remaining.c).toBe(1);
	});

	it("respects maxBatches (stops before fully draining an over-cap backlog)", async () => {
		const { db, sqlite } = realDb();
		for (let i = 0; i < 6; i++) seedTedi(sqlite, `old-${i}`, OLD);

		// batchSize 2, maxBatches 2 → at most 4 deleted this tick.
		const deleted = await deleteOldTediRuntimeEvents(db, 90, 2, 2);
		expect(deleted).toBe(4);

		const remaining = sqlite
			.prepare(`SELECT COUNT(*) AS c FROM tedi_runtime_events`)
			.get() as {
			c: number;
		};
		expect(remaining.c).toBe(2);
	});
});

describe("deleteOldKernelRuntimeEvents", () => {
	it("prunes old kernel events but never touches kernel_conversations", async () => {
		const { db, sqlite } = realDb();
		seedKernel(sqlite, "old-1", OLD);
		seedKernel(sqlite, "new-1", NEW);
		sqlite
			.prepare(
				`INSERT INTO kernel_conversations (id, organization_id, created_at) VALUES ('conv1', 'org1', ?)`,
			)
			.run(OLD);

		const deleted = await deleteOldKernelRuntimeEvents(db, 90);
		expect(deleted).toBe(1);

		const events = sqlite
			.prepare(`SELECT id FROM kernel_runtime_events`)
			.all() as Array<{
			id: string;
		}>;
		expect(events.map((r) => r.id)).toEqual(["new-1"]);

		// The durable sidebar projection is untouched by event pruning.
		const convs = sqlite
			.prepare(`SELECT COUNT(*) AS c FROM kernel_conversations`)
			.get() as {
			c: number;
		};
		expect(convs.c).toBe(1);
	});
});

describe("deleteOldCronExecutions (space-format datetime cutoff)", () => {
	// tedi_cron_executions.created_at is left on the CURRENT_TIMESTAMP default
	// (space-format "YYYY-MM-DD HH:MM:SS"), so the retention fn uses a
	// datetime('now', '-N days') SQL cutoff — NOT an ISO string. This proves that
	// path deletes the space-format rows correctly (an ISO cutoff would mis-sort).
	it("deletes only space-format rows older than the datetime() cutoff", async () => {
		const { db, sqlite } = realDb();
		// Old: fixed far-past space-format timestamps.
		sqlite
			.prepare(
				`INSERT INTO tedi_cron_executions (id, created_at) VALUES (?, ?)`,
			)
			.run("old-1", "2020-01-01 00:00:00");
		sqlite
			.prepare(
				`INSERT INTO tedi_cron_executions (id, created_at) VALUES (?, ?)`,
			)
			.run("old-2", "2021-06-15 12:30:00");
		// New: current space-format timestamp (matches the CURRENT_TIMESTAMP default).
		sqlite
			.prepare(
				`INSERT INTO tedi_cron_executions (id, created_at) VALUES ('new-1', datetime('now'))`,
			)
			.run();

		const deleted = await deleteOldCronExecutions(db, 90);
		expect(deleted).toBe(2);

		const survivors = sqlite
			.prepare(`SELECT id FROM tedi_cron_executions ORDER BY id`)
			.all() as Array<{ id: string }>;
		expect(survivors.map((r) => r.id)).toEqual(["new-1"]);
	});
});

describe("deleteOldCatalogChanges (ISO-Z detected_at, 90d)", () => {
	// app_catalog_changes.detected_at is ISO-8601 Z in production (every writer
	// stamps toISOString(); 115,949/115,949 rows verified ISO-Z, zero
	// space-format), so the retention fn uses an ISO cutoff — NOT
	// datetime('now', ...). See the format guard at the bottom of this block.
	function seedChange(sqlite: DatabaseSync, id: string, detectedAt: string) {
		sqlite
			.prepare(
				`INSERT INTO app_catalog_changes (id, catalog_app_id, change_type, detected_at) VALUES (?, 'app1', 'updated', ?)`,
			)
			.run(id, detectedAt);
	}

	it("deletes only rows older than the cutoff; newer rows survive", async () => {
		const { db, sqlite } = realDb();
		seedChange(sqlite, "old-1", OLD);
		seedChange(sqlite, "old-2", OLD);
		seedChange(sqlite, "new-1", NEW);

		const deleted = await deleteOldCatalogChanges(db, 90);
		expect(deleted).toBe(2);

		const survivors = sqlite
			.prepare(`SELECT id FROM app_catalog_changes ORDER BY id`)
			.all() as Array<{ id: string }>;
		expect(survivors.map((r) => r.id)).toEqual(["new-1"]);
	});

	it("drains a backlog across multiple batches (id-IN-subquery idiom)", async () => {
		const { db, sqlite } = realDb();
		for (let i = 0; i < 5; i++) seedChange(sqlite, `old-${i}`, OLD);
		seedChange(sqlite, "new-1", NEW);

		// batchSize 2 → 3 batches (2 + 2 + 1) drain all 5 old rows.
		const deleted = await deleteOldCatalogChanges(db, 90, 2, 40);
		expect(deleted).toBe(5);

		const remaining = sqlite
			.prepare(`SELECT COUNT(*) AS c FROM app_catalog_changes`)
			.get() as { c: number };
		expect(remaining.c).toBe(1);
	});

	it("cuts at the 90d boundary, not the calendar day", async () => {
		const { db, sqlite } = realDb();
		const cutoffMs = Date.now() - 90 * 86_400_000;
		// One hour past the cutoff instant → must be deleted. One hour inside it →
		// must survive. Both are ISO-Z, like production rows.
		seedChange(
			sqlite,
			"just-old",
			new Date(cutoffMs - 3_600_000).toISOString(),
		);
		seedChange(
			sqlite,
			"just-new",
			new Date(cutoffMs + 3_600_000).toISOString(),
		);

		const deleted = await deleteOldCatalogChanges(db, 90);
		expect(deleted).toBe(1);

		const survivors = sqlite
			.prepare(`SELECT id FROM app_catalog_changes`)
			.all() as Array<{ id: string }>;
		expect(survivors.map((r) => r.id)).toEqual(["just-new"]);
	});

	it("format guard: a space-format datetime() cutoff silently misses same-day ISO-Z rows", () => {
		// Why deleteOldCatalogChanges must NOT use dtCutoff(). Fixed literals, so
		// this is deterministic: an ISO-Z row genuinely older than the cutoff
		// INSTANT but on the same calendar DAY compares as NEWER than a
		// space-format cutoff, because 'T' (0x54) > ' ' (0x20). The row is then
		// silently retained — no error, just a policy that quietly under-deletes.
		const { sqlite } = realDb();
		const isoRow = "2026-05-06T04:00:00.000Z"; // older than the cutoff instant
		const spaceCutoff = "2026-05-06 09:53:31"; // what datetime('now','-90 days') returns
		const isoCutoffLiteral = "2026-05-06T09:53:31.000Z"; // what isoCutoff(90) returns

		const wrong = sqlite
			.prepare(`SELECT (? < ?) AS wouldDelete`)
			.get(isoRow, spaceCutoff) as { wouldDelete: number };
		expect(wrong.wouldDelete).toBe(0); // the bug: row missed

		const right = sqlite
			.prepare(`SELECT (? < ?) AS wouldDelete`)
			.get(isoRow, isoCutoffLiteral) as { wouldDelete: number };
		expect(right.wouldDelete).toBe(1); // matching formats → correct
	});
});
