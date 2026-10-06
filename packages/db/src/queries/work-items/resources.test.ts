import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { listWorkResourcePools } from "./resources";

const NOW = "2026-09-20T00:00:00.000Z";
const ORG = "org-a";
const KEY = "file:tedix:src/last.ts";
const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});
function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec(`
CREATE TABLE work_resource_pools (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, resource_key TEXT NOT NULL, allocation_mode TEXT NOT NULL, capacity INTEGER NOT NULL, owner_ref TEXT, enabled INTEGER NOT NULL DEFAULT 1, metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT, version INTEGER NOT NULL DEFAULT 1);
CREATE UNIQUE INDEX uniq_work_resource_pool_key ON work_resource_pools(org_id,resource_key);
CREATE TABLE work_resource_reservations (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, pool_id TEXT NOT NULL, quantity INTEGER NOT NULL, state TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE INDEX reservation_pool ON work_resource_reservations(org_id,pool_id,state,expires_at);
`);
	const queries: { sql: string; params: unknown[] }[] = [];
	const d1 = createD1Facade(sqlite);
	const prepare = d1.prepare.bind(d1);
	d1.prepare = (sql) => {
		const statement = prepare(sql);
		const bind = statement.bind.bind(statement);
		statement.bind = (...params) => {
			queries.push({ sql, params });
			return bind(...params);
		};
		return statement;
	};
	const seed = (
		id: string,
		key: string,
		org = ORG,
		enabled = 1,
		capacity = 1,
	) =>
		sqlite
			.prepare(
				"INSERT INTO work_resource_pools (id,org_id,resource_key,allocation_mode,capacity,owner_ref,enabled,created_at) VALUES (?,?,?,'capacity',?,'owner',?,?)",
			)
			.run(id, org, key, capacity, enabled, NOW);
	return { sqlite, db: createDbQueryClient(d1), seed, queries };
}

describe("exact Work resource pool reads", () => {
	it("finds a key beyond 800 unrelated pools using the org/key index", async () => {
		const { db, sqlite, seed, queries } = fixture();
		for (let i = 0; i < 801; i++)
			seed(String(i).padStart(4, "0"), `unrelated:${i}`);
		seed("9999", KEY);
		const result = await listWorkResourcePools(db, {
			orgId: ORG,
			resourceKey: KEY,
			limit: 1,
			at: NOW,
		});
		expect(result.data.map(({ pool }) => pool.resourceKey)).toEqual([KEY]);
		expect(result.nextCursor).toBeNull();
		expect(result.observedAt).toBe(NOW);
		expect(queries).toHaveLength(1);
		const query = queries[0]!;
		const plan = sqlite
			.prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
			.all(...(query.params as [])) as { detail: string }[];
		expect(
			plan.some(({ detail }) =>
				/SEARCH work_resource_pools USING INDEX uniq_work_resource_pool_key.*org_id=\?.*resource_key=\?/.test(
					detail,
				),
			),
		).toBe(true);
		expect(
			plan.some(({ detail }) => /SCAN work_resource_pools/.test(detail)),
		).toBe(false);
		const absent = await listWorkResourcePools(db, {
			orgId: ORG,
			resourceKey: "absent",
			limit: 1,
			at: NOW,
		});
		expect(absent.data).toEqual([]);
		expect(absent.nextCursor).toBeNull();
	});

	it("keeps tenant, enabled and active reservation predicates with exact matching", async () => {
		const { db, sqlite, seed, queries } = fixture();
		seed("a", KEY, ORG, 1, 10);
		seed("b", KEY, "org-b", 1, 99);
		seed("c", "disabled", ORG, 0);
		seed("d", `${KEY}:suffix`);
		for (const [id, org, quantity, state, expiry] of [
			["active", ORG, 3, "active", "2026-09-21T00:00:00.000Z"],
			["expired", ORG, 5, "active", NOW],
			["settled", ORG, 5, "settled", "2026-09-21T00:00:00.000Z"],
			["other-org", "org-b", 9, "active", "2026-09-21T00:00:00.000Z"],
		] as const)
			sqlite
				.prepare(
					"INSERT INTO work_resource_reservations VALUES (?,?, 'a',?,?,?)",
				)
				.run(id, org, quantity, state, expiry);
		const result = await listWorkResourcePools(db, {
			orgId: ORG,
			resourceKey: KEY,
			at: NOW,
		});
		expect(queries[0]?.sql).toContain(
			'r.org_id="work_resource_pools"."org_id"',
		);
		expect(queries[0]?.sql).toContain('r.pool_id="work_resource_pools"."id"');
		expect(result.data).toHaveLength(1);
		expect(result.data[0]).toMatchObject({
			pool: {
				id: "a",
				orgId: ORG,
				resourceKey: KEY,
				ownerRef: "owner",
				capacity: 10,
			},
			activeReserved: 3,
			effectiveAvailable: 7,
		});
		expect(
			(
				await listWorkResourcePools(db, {
					orgId: "missing-org",
					resourceKey: KEY,
					at: NOW,
				})
			).data,
		).toEqual([]);
		expect(
			(
				await listWorkResourcePools(db, {
					orgId: ORG,
					resourceKey: "disabled",
					at: NOW,
				})
			).data,
		).toEqual([]);
		expect(
			(
				await listWorkResourcePools(db, {
					orgId: ORG,
					resourceKey: "disabled",
					includeDisabled: true,
					at: NOW,
				})
			).data,
		).toHaveLength(1);
	});

	it("preserves unfiltered keyset pages and treats filter text literally", async () => {
		const { db, seed } = fixture();
		seed("a", "literal_%' key");
		seed("b", "literal_X' key");
		seed("c", "other");
		const first = await listWorkResourcePools(db, {
			orgId: ORG,
			limit: 2,
			at: NOW,
		});
		expect(first.data.map(({ pool }) => pool.id)).toEqual(["a", "b"]);
		expect(first.nextCursor).toBe("b");
		const next = await listWorkResourcePools(db, {
			orgId: ORG,
			limit: 2,
			cursor: first.nextCursor!,
			at: NOW,
		});
		expect(next.data.map(({ pool }) => pool.id)).toEqual(["c"]);
		expect(next.nextCursor).toBeNull();
		expect(
			(
				await listWorkResourcePools(db, {
					orgId: ORG,
					resourceKey: "literal_%' key",
					at: NOW,
				})
			).data.map(({ pool }) => pool.id),
		).toEqual(["a"]);
		expect(
			(
				await listWorkResourcePools(db, {
					orgId: ORG,
					resourceKey: "literal_%' key",
					cursor: "a",
					at: NOW,
				})
			).data,
		).toEqual([]);
	});
});
