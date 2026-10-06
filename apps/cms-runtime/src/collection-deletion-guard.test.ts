/// <reference types="@cloudflare/vitest-plugin/types" />
import { describe, expect, test, vi } from "vite-plus/test";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { createDialect } from "@emdash-cms/cloudflare/db/do-sql";
import { Kysely, sql } from "../../cms/templates/tedix/node_modules/kysely";

import { EmDashDB, TenantEmDashDB } from "./index";

const input = {
	action: "fence" as const,
	collectionId: "pages-id",
	collectionSlug: "pages",
	leaseToken: "exact-lease",
	forceDelete: false,
};

function acceptingPermitD1(): D1Database {
	return {
		prepare: () => ({
			bind: () => ({ all: async () => ({ results: [{ id: "permit" }] }) }),
		}),
	} as unknown as D1Database;
}

describe("Emdash collection deletion across the tenant RPC boundary", () => {
	test("forwards the exact guard request to the slug-owned Durable Object", async () => {
		const executeCollectionDeletionGuard = vi
			.fn()
			.mockResolvedValue({ outcome: "fenced" });
		const idFromName = vi.fn((name: string) => name);
		const get = vi.fn(() => ({ executeCollectionDeletionGuard }));
		const entrypoint = Object.assign(Object.create(TenantEmDashDB.prototype), {
			ctx: {
				props: { name: "tenant-a", siteId: "site-1", slug: "tenant-a" },
			},
			env: { PLATFORM_DB: acceptingPermitD1(), DB_DO: { idFromName, get } },
		}) as TenantEmDashDB;

		expect(await entrypoint.executeCollectionDeletionGuard(input)).toEqual({
			outcome: "fenced",
		});
		expect(idFromName).toHaveBeenCalledExactlyOnceWith("tenant-a");
		expect(get).toHaveBeenCalledExactlyOnceWith("tenant-a");
		expect(executeCollectionDeletionGuard).toHaveBeenCalledExactlyOnceWith(
			input,
		);
	});

	test("fences an empty collection inside the real local Durable Object", async () => {
		const namespace = (
			env as unknown as {
				DB_DO: DurableObjectNamespace<EmDashDB>;
			}
		).DB_DO;
		const id = namespace.idFromName(`guard-test-${crypto.randomUUID()}`);
		const db = namespace.get(id) as unknown as {
			query(
				sql: string,
				params?: unknown[],
			): Promise<{ rows: Record<string, unknown>[] }>;
			executeCollectionDeletionGuard(
				value: typeof input,
			): Promise<{ outcome: string }>;
		};
		await db.query(
			"CREATE TABLE _emdash_media_usage_collection_deletions (collection_id TEXT NOT NULL PRIMARY KEY, collection_slug TEXT NOT NULL UNIQUE, force_delete INTEGER NOT NULL, state TEXT NOT NULL, phase TEXT NOT NULL, work_cursor TEXT, source_key TEXT, occurrence_cursor TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL, lease_token TEXT, lease_expires_at TEXT, last_error_code TEXT, created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '')",
		);
		await db.query(
			"CREATE INDEX deletion_due ON _emdash_media_usage_collection_deletions (state, next_attempt_at, updated_at, collection_id)",
		);
		await db.query(
			"CREATE INDEX deletion_lease ON _emdash_media_usage_collection_deletions (state, lease_expires_at, updated_at, collection_id)",
		);
		await db.query(
			"CREATE INDEX deletion_operator ON _emdash_media_usage_collection_deletions (state, updated_at, collection_id)",
		);
		await db.query(
			"CREATE TABLE _emdash_media_usage_index_status (adapter_id TEXT NOT NULL, scope_type TEXT NOT NULL, scope_key TEXT NOT NULL, status TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1, started_at TEXT, completed_at TEXT, cursor TEXT, indexed_source_count INTEGER NOT NULL DEFAULT 0, failed_source_count INTEGER NOT NULL DEFAULT 0, last_error_code TEXT, updated_at TEXT NOT NULL, collection_id TEXT, capture_state TEXT, PRIMARY KEY (adapter_id, scope_type, scope_key))",
		);
		await db.query(
			"CREATE INDEX status_state ON _emdash_media_usage_index_status (adapter_id, status)",
		);
		await db.query(
			"CREATE INDEX status_collection ON _emdash_media_usage_index_status (adapter_id, scope_type, collection_id)",
		);
		await db.query(
			"CREATE TABLE _emdash_collections (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, label TEXT NOT NULL)",
		);
		await db.query("CREATE TABLE ec_pages (id TEXT, deleted_at TEXT)");
		await db.query(
			"INSERT INTO _emdash_media_usage_collection_deletions (collection_id, collection_slug, force_delete, state, phase, next_attempt_at, lease_token, lease_expires_at) VALUES (?, ?, 0, 'leased', 'fence', '', ?, '2999-01-01T00:00:00.000Z')",
			[input.collectionId, input.collectionSlug, input.leaseToken],
		);
		await db.query(
			"INSERT INTO _emdash_media_usage_index_status (adapter_id, scope_type, scope_key, collection_id, status, capture_state, updated_at) VALUES ('content-media', 'collection', ?, ?, 'stale', 'active', '')",
			[input.collectionSlug, input.collectionId],
		);
		await db.query(
			"INSERT INTO _emdash_collections (id, slug, label) VALUES (?, ?, 'Pages')",
			[input.collectionId, input.collectionSlug],
		);

		expect(await db.executeCollectionDeletionGuard(input)).toEqual({
			outcome: "fenced",
		});
		expect(
			(
				await db.query(
					"SELECT capture_state FROM _emdash_media_usage_index_status WHERE collection_id = ?",
					[input.collectionId],
				)
			).rows,
		).toEqual([{ capture_state: "deleting" }]);
	});
});

type RegistryGuardDatabase = {
	query(
		sql: string,
		params?: unknown[],
	): Promise<{ rows: Record<string, unknown>[]; changes?: number }>;
	executeCollectionDeletionGuard(input: {
		action: "registry" | "drop";
		collectionId: string;
		collectionSlug: string;
		leaseToken: string;
	}): Promise<{ outcome: string }>;
};

async function registryDatabase(
	name = `registry-guard-test-${crypto.randomUUID()}`,
): Promise<RegistryGuardDatabase> {
	const namespace = (
		env as unknown as { DB_DO: DurableObjectNamespace<EmDashDB> }
	).DB_DO;
	const id = namespace.idFromName(name);
	const db = namespace.get(id) as unknown as RegistryGuardDatabase;
	await db.query(
		"CREATE TABLE _emdash_media_usage_collection_deletions (collection_id TEXT NOT NULL PRIMARY KEY, collection_slug TEXT NOT NULL UNIQUE, force_delete INTEGER NOT NULL, state TEXT NOT NULL, phase TEXT NOT NULL, work_cursor TEXT, source_key TEXT, occurrence_cursor TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL, lease_token TEXT, lease_expires_at TEXT, last_error_code TEXT, created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '')",
	);
	await db.query(
		"CREATE INDEX deletion_due ON _emdash_media_usage_collection_deletions (state, next_attempt_at, updated_at, collection_id)",
	);
	await db.query(
		"CREATE INDEX deletion_lease ON _emdash_media_usage_collection_deletions (state, lease_expires_at, updated_at, collection_id)",
	);
	await db.query(
		"CREATE INDEX deletion_operator ON _emdash_media_usage_collection_deletions (state, updated_at, collection_id)",
	);
	await db.query(
		"CREATE TABLE _emdash_collections (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, label TEXT NOT NULL)",
	);
	await db.query(
		"INSERT INTO _emdash_media_usage_collection_deletions (collection_id, collection_slug, force_delete, state, phase, next_attempt_at, lease_token, lease_expires_at) VALUES (?, ?, 0, 'leased', 'registry', '', ?, '2999-01-01T00:00:00.000Z')",
		[input.collectionId, input.collectionSlug, input.leaseToken],
	);
	await db.query(
		"INSERT INTO _emdash_collections (id, slug, label) VALUES (?, ?, 'Pages')",
		[input.collectionId, input.collectionSlug],
	);
	return db;
}

const registryInput = {
	action: "registry" as const,
	collectionId: input.collectionId,
	collectionSlug: input.collectionSlug,
	leaseToken: input.leaseToken,
};

async function registryState(db: RegistryGuardDatabase) {
	return {
		collections: (
			await db.query("SELECT id FROM _emdash_collections WHERE id = ?", [
				input.collectionId,
			])
		).rows,
		deletions: (
			await db.query(
				"SELECT phase FROM _emdash_media_usage_collection_deletions WHERE collection_id = ?",
				[input.collectionId],
			)
		).rows,
	};
}

describe("Emdash registry deletion in the owning Durable Object", () => {
	test("reports affected rows for a leased deletion phase update", async () => {
		const db = await registryDatabase();
		const result = await db.query(
			"UPDATE _emdash_media_usage_collection_deletions SET phase = 'work', attempt_count = 0, last_error_code = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE collection_id = ? AND state = 'leased' AND lease_token = ? AND EXISTS (SELECT 1 FROM _emdash_media_usage_collection_deletions AS deletion WHERE deletion.collection_id = ? AND deletion.state = 'leased' AND deletion.lease_token = ? AND deletion.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
			[
				input.collectionId,
				input.leaseToken,
				input.collectionId,
				input.leaseToken,
			],
		);
		expect(result.changes).toBe(1);
		expect(
			(
				await db.query(
					"SELECT phase FROM _emdash_media_usage_collection_deletions WHERE collection_id = ?",
					[input.collectionId],
				)
			).rows,
		).toEqual([{ phase: "work" }]);
	});

	test("maps the persisted phase update to one Kysely updated row", async () => {
		const name = `deletion-update-result-${crypto.randomUUID()}`;
		const durableObject = await registryDatabase(name);
		const db = new Kysely<{
			_emdash_media_usage_collection_deletions: {
				collection_id: string;
				state: string;
				phase: string;
				lease_token: string | null;
				lease_expires_at: string | null;
				attempt_count: number;
				last_error_code: string | null;
				updated_at: string;
			};
		}>({ dialect: createDialect({ binding: "DB_DO", name }) });
		try {
			const result = await db
				.updateTable("_emdash_media_usage_collection_deletions")
				.set({
					phase: "work",
					attempt_count: 0,
					last_error_code: null,
					updated_at: sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
				})
				.where("collection_id", "=", input.collectionId)
				.where("state", "=", "leased")
				.where("lease_token", "=", input.leaseToken)
				.where(
					sql<boolean>`EXISTS (
						SELECT 1 FROM _emdash_media_usage_collection_deletions AS deletion
						WHERE deletion.collection_id = ${input.collectionId}
							AND deletion.state = 'leased'
							AND deletion.lease_token = ${input.leaseToken}
							AND deletion.lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
					)`,
				)
				.executeTakeFirst();
			expect(result.numUpdatedRows).toBe(1n);
			expect(
				(
					await durableObject.query(
						"SELECT phase FROM _emdash_media_usage_collection_deletions WHERE collection_id = ?",
						[input.collectionId],
					)
				).rows,
			).toEqual([{ phase: "work" }]);
		} finally {
			await db.destroy();
		}
	});

	test("atomically checkpoints the lease and deletes the registry row", async () => {
		const db = await registryDatabase();
		expect(await db.executeCollectionDeletionGuard(registryInput)).toEqual({
			outcome: "registry_deleted",
		});
		expect(await registryState(db)).toEqual({
			collections: [],
			deletions: [{ phase: "table" }],
		});
	});

	test("rejects a stale lease without changing either row", async () => {
		const db = await registryDatabase();
		expect(
			await db.executeCollectionDeletionGuard({
				...registryInput,
				leaseToken: "stale-lease",
			}),
		).toEqual({ outcome: "stale" });
		expect(await registryState(db)).toEqual({
			collections: [{ id: input.collectionId }],
			deletions: [{ phase: "registry" }],
		});
	});

	test("rolls the checkpoint back when registry deletion fails", async () => {
		const db = await registryDatabase();
		await db.query(
			"CREATE TRIGGER reject_registry_delete BEFORE DELETE ON _emdash_collections BEGIN SELECT RAISE(ABORT, 'forced registry failure'); END",
		);
		const error = await runInDurableObject(
			db as unknown as DurableObjectStub<EmDashDB>,
			async (instance: EmDashDB) => {
				try {
					await instance.executeCollectionDeletionGuard(registryInput);
					return null;
				} catch (cause) {
					return cause instanceof Error ? cause.message : String(cause);
				}
			},
		);
		expect(error).toContain("forced registry failure");
		expect(await registryState(db)).toEqual({
			collections: [{ id: input.collectionId }],
			deletions: [{ phase: "registry" }],
		});
	});

	test("completes a previously deleted registry row after lease recovery", async () => {
		const db = await registryDatabase();
		await db.query("DELETE FROM _emdash_collections WHERE id = ?", [
			input.collectionId,
		]);
		expect(await db.executeCollectionDeletionGuard(registryInput)).toEqual({
			outcome: "registry_deleted",
		});
		expect(await registryState(db)).toEqual({
			collections: [],
			deletions: [{ phase: "table" }],
		});
	});

	test("drops a seeded content table after the registry checkpoint", async () => {
		const db = await registryDatabase();
		await db.query("CREATE TABLE ec_pages (id TEXT, deleted_at TEXT)");
		await db.query(
			"CREATE VIRTUAL TABLE _emdash_fts_pages USING fts5(id UNINDEXED, title)",
		);
		await db.query(
			"CREATE TRIGGER _emdash_fts_pages_insert AFTER INSERT ON ec_pages BEGIN INSERT INTO _emdash_fts_pages (id, title) VALUES (new.id, ''); END",
		);
		expect(await db.executeCollectionDeletionGuard(registryInput)).toEqual({
			outcome: "registry_deleted",
		});
		expect(
			await db.executeCollectionDeletionGuard({
				action: "drop",
				collectionId: input.collectionId,
				collectionSlug: input.collectionSlug,
				leaseToken: input.leaseToken,
			}),
		).toEqual({ outcome: "dropped" });
		expect(
			(
				await db.query(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('ec_pages', '_emdash_fts_pages')",
				)
			).rows,
		).toEqual([]);
	});
});
