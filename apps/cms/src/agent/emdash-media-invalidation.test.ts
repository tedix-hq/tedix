import { DatabaseSync } from "node:sqlite";

import { describe, expect, test, vi } from "vite-plus/test";

// Upstream Emdash counts the guarded schema invalidation with
// `numUpdatedRows === 1`. On indexed Durable Object storage that holds because
// the parent EmDashDB (patches/@emdash-cms/cloudflare) reports SQLite
// `changes()` rather than `rowsWritten`, which also bills index writes; the
// cms-runtime collection-deletion-guard test proves that on a real DO. This
// test proves the other half: the starter's Worker Loader dialect carries that
// count into Kysely, so the unpatched repository needs no starter patch.
const sqlite = new DatabaseSync(":memory:");
const parentDb = {
	async query(sql: string, params: unknown[] = []) {
		const statement = sqlite.prepare(sql);
		if (/^\s*select\b/i.test(sql)) {
			return { rows: statement.all(...(params as never[])) };
		}
		const { changes } = statement.run(...(params as never[]));
		return { rows: [], changes: Number(changes) };
	},
	async batchQuery() {
		throw new Error("writes never coalesce");
	},
	async executeCollectionDeletionGuard() {
		throw new Error("unused");
	},
};
vi.mock("cloudflare:workers", () => ({ env: { DB_DO: parentDb } }));

// The starter adapter is typed against the starter's own Worker `Env`, so it
// stays out of this app's tsc program; load it by runtime specifier.
const starterAdapter =
	"../../templates/marketing/src/lib/worker-loader-do-sql-runtime";
const { createDialect } = (await import(/* @vite-ignore */ starterAdapter)) as {
	createDialect(config: { binding: string }): never;
};
const { Kysely } =
	await import("../../templates/marketing/node_modules/kysely");
const { MediaUsageRepository } =
	await import("../../templates/marketing/node_modules/emdash/src/database/repositories/media-usage");

sqlite.exec(`
	CREATE TABLE _emdash_media_usage_index_status (adapter_id TEXT NOT NULL, scope_type TEXT NOT NULL, scope_key TEXT NOT NULL, status TEXT NOT NULL, change_epoch INTEGER NOT NULL DEFAULT 0, reconciliation_required INTEGER NOT NULL DEFAULT 0, completed_at TEXT, cursor TEXT, last_error_code TEXT, updated_at TEXT NOT NULL, collection_id TEXT, capture_state TEXT, PRIMARY KEY (adapter_id, scope_type, scope_key));
	CREATE INDEX status_state ON _emdash_media_usage_index_status (adapter_id, status);
	CREATE INDEX status_collection ON _emdash_media_usage_index_status (adapter_id, scope_type, collection_id);
	CREATE TABLE _emdash_collections (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, label TEXT NOT NULL);
	CREATE TABLE _emdash_media_usage_activation (task_key TEXT PRIMARY KEY, state TEXT NOT NULL);
	INSERT INTO _emdash_collections (id, slug, label) VALUES ('pages-id', 'pages', 'Pages');
	INSERT INTO _emdash_media_usage_activation (task_key, state) VALUES ('incremental_capture', 'active');
	INSERT INTO _emdash_media_usage_index_status (adapter_id, scope_type, scope_key, collection_id, status, capture_state, updated_at) VALUES ('content-media', 'collection', 'pages', 'pages-id', 'complete', 'active', '');
`);

describe("Emdash media usage schema invalidation through the starter DO dialect", () => {
	const repo = new MediaUsageRepository(
		new Kysely({ dialect: createDialect({ binding: "DB_DO" }) }) as never,
	);

	test("counts the one guarded row the parent reports", async () => {
		expect(await repo.invalidateIndexStatusForSchemaChange("pages")).toBe(true);
		expect(
			sqlite
				.prepare(
					"SELECT status, change_epoch FROM _emdash_media_usage_index_status",
				)
				.all(),
		).toEqual([{ status: "stale", change_epoch: 1 }]);
	});

	test("fails closed when the guard matches no row", async () => {
		expect(await repo.invalidateIndexStatusForSchemaChange("posts")).toBe(
			false,
		);
	});
});
