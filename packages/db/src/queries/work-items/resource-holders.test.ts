import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { workAttempts, workItems } from "../../schema/work-items";
import {
	workResourcePools,
	workResourceReservations,
} from "../../schema/work-factory";
import { createD1Facade } from "../../test/d1-facade";
import { tableDdl } from "../../test/schema-ddl";
import {
	listActiveWorkResourceHolders,
	listWorkResourcePools,
} from "./resources";

const NOW = "2026-10-03T12:00:00.000Z";
const FUTURE = "2026-10-03T12:05:00.000Z";
const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	databases.push(sqlite);
	for (const table of [
		workItems,
		workAttempts,
		workResourcePools,
		workResourceReservations,
	])
		sqlite.exec(tableDdl(table).join(";"));
	const db = createDbQueryClient(createD1Facade(sqlite));
	const pool = (id: string, org = "org-a") =>
		sqlite
			.prepare(
				"INSERT INTO work_resource_pools (id,org_id,resource_key,allocation_mode,capacity,created_at) VALUES (?,?,?,'exclusive',1,?)",
			)
			.run(id, org, `file:${id}`, NOW);
	const holder = (
		id: string,
		{
			org = "org-a",
			poolId = "pool",
			state = "active",
			expiresAt = FUTURE,
			attemptOrg = org,
			itemOrg = org,
		} = {},
	) => {
		sqlite
			.prepare(
				"INSERT INTO work_items (id,org_id,title,created_at) VALUES (?,?,?,?)",
			)
			.run(`work-${id}`, itemOrg, `Work ${id}`, NOW);
		sqlite
			.prepare(
				"INSERT INTO work_attempts (id,admission_id,work_item_id,org_id,executor_type,executor_id,executor_session_id,external_session_key,attempt_number,started_at,heartbeat_at,expires_at) VALUES (?,?,?,?,'external_agent','principal','session',?,1,?,?,?)",
			)
			.run(
				`attempt-${id}`,
				`admission-${id}`,
				`work-${id}`,
				attemptOrg,
				`codex:chat-${id}`,
				NOW,
				NOW,
				expiresAt,
			);
		sqlite
			.prepare(
				"INSERT INTO work_resource_reservations (id,org_id,admission_id,work_item_id,pool_id,pool_version,resource_key,quantity,state,reserved_at,expires_at) VALUES (?,?,?,?,?,1,?,1,?,?,?)",
			)
			.run(
				id,
				org,
				`admission-${id}`,
				`work-${id}`,
				poolId,
				`file:${poolId}`,
				state,
				NOW,
				expiresAt,
			);
	};
	return { sqlite, db, pool, holder };
}
describe("current resource holder projections", () => {
	it("links only active unexpired same-tenant reservations to their admitted Work and session", async () => {
		const { db, pool, holder } = fixture();
		pool("pool");
		holder("valid");
		holder("expired", { expiresAt: NOW });
		holder("settled", { state: "settled" });
		holder("foreign", { org: "org-b" });
		holder("foreign-attempt", { attemptOrg: "org-b" });
		holder("foreign-work", { itemOrg: "org-b" });
		holder("other-pool", { poolId: "other" });
		const rows = await listActiveWorkResourceHolders(db, {
			orgId: "org-a",
			poolIds: ["pool"],
			at: NOW,
		});
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			workItemId: "work-valid",
			workTitle: "Work valid",
			attemptId: "attempt-valid",
			externalSessionKey: "codex:chat-valid",
			quantity: 1,
			expiresAt: FUTURE,
		});
		expect(
			await listActiveWorkResourceHolders(db, {
				orgId: "org-a",
				poolIds: [],
				at: NOW,
			}),
		).toEqual([]);
	});
	it("retains an overflow row independently for every pool", async () => {
		const { db, pool, holder } = fixture();
		pool("pool");
		pool("next");
		for (let n = 0; n < 12; n++) holder(`holder-${String(n).padStart(2, "0")}`);
		holder("second", { poolId: "next" });
		const rows = await listActiveWorkResourceHolders(db, {
			orgId: "org-a",
			poolIds: ["pool", "next"],
			at: NOW,
		});
		expect(rows.filter((row) => row.poolId === "pool")).toHaveLength(9);
		expect(rows.filter((row) => row.poolId === "next")).toHaveLength(1);
	});
	it("filters pressure before pagination and respects expiry and exact keys", async () => {
		const { db, pool, holder } = fixture();
		pool("available");
		pool("pool");
		pool("expired");
		holder("valid");
		holder("old", { poolId: "expired", expiresAt: NOW });
		const page = await listWorkResourcePools(db, {
			orgId: "org-a",
			at: NOW,
			saturatedOnly: true,
			limit: 1,
		});
		expect(page.data.map((row) => row.pool.id)).toEqual(["pool"]);
		expect(page.nextCursor).toBeNull();
		expect(
			(
				await listWorkResourcePools(db, {
					orgId: "org-a",
					at: NOW,
					saturatedOnly: true,
					resourceKey: "file:available",
				})
			).data,
		).toEqual([]);
	});
	it("keeps holder reads inside D1's parameter limit for a full pool page", async () => {
		const { db, pool, holder } = fixture();
		const ids = Array.from({ length: 101 }, (_, n) => `pool-${n}`);
		for (const id of ids) {
			pool(id);
			holder(id, { poolId: id });
		}
		const rows = await listActiveWorkResourceHolders(db, {
			orgId: "org-a",
			poolIds: ids,
			at: NOW,
		});
		expect(rows).toHaveLength(101);
		expect(new Set(rows.map((row) => row.poolId))).toEqual(new Set(ids));
	});
});
