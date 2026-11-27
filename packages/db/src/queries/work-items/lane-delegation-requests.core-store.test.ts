import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { DbClient } from "../../client";
import { createPGliteFacade } from "../../test/pglite-facade";
import {
	retireStaleLaneDelegationRequests,
	settleLaneDelegationRequests,
} from "./lane-delegation-requests";

const NOW = "2026-11-06T12:00:00.000Z";
const lane = (version: number) =>
	JSON.stringify({
		laneBlocker: {
			kind: "owner_delegation",
			executor: "codex",
			workVersion: version,
		},
	});

// D1 runs these in lane-delegation-requests.test.ts; this covers the Postgres dialect paths.
describe("lane delegation requests on Postgres", () => {
	let db: DbClient;
	let close: () => unknown;
	beforeAll(async () => {
		const fixture = await createPGliteFacade();
		for (const migration of readMigrationFiles({
			migrationsFolder: fileURLToPath(
				new URL("../../../drizzle-pg", import.meta.url),
			),
		}))
			for (const ddl of migration.sql) await fixture.engine.exec(ddl);
		// Table shapes only: no writer triggers or foreign keys.
		await fixture.engine.exec("SET session_replication_role = replica");
		db = fixture.db;
		close = fixture.close;
		await fixture.engine.exec(`
			INSERT INTO work_items(id,org_id,title,disposition,version,created_at,accountable_owner_type,accountable_owner_id,executor_type,executor_id)
			VALUES ('work','org','Task','accepted',3,'${NOW}','user','owner','external_agent','codex'),
				('handed','org','Handed','accepted',1,'${NOW}','user','owner','external_agent','codex');
			INSERT INTO work_item_comments(id,org_id,work_item_id,author_type,author_id,body,created_at)
			VALUES ('note','org','handed','user','owner',E'Looks fine.\\nDelegation: codex work-version=1 Rotate the staging key.','${NOW}');
			INSERT INTO work_interactions(id,org_id,work_item_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,status,source,metadata,version,created_at)
			VALUES ('old-version','org','work','question','A','?','user','op','user','owner','open','lane-dispatch-blocker','${lane(2)}',1,'2026-11-06T10:00:00.000Z'),
				('current','org','work','question','B','?','user','op','user','owner','open','lane-dispatch-blocker','${lane(3)}',1,'2026-11-06T11:00:00.000Z'),
				('current-dup','org','work','question','C','?','user','op','user','owner','open','lane-dispatch-blocker','${lane(3)}',1,'2026-11-06T11:30:00.000Z'),
				('handed-ask','org','handed','question','D','?','user','op','user','owner','open','lane-dispatch-blocker','${lane(1)}',1,'2026-11-06T11:00:00.000Z');
		`);
	});
	afterAll(() => close());

	it("retires moved, hand-delegated and duplicate asks, then returns the current one", async () => {
		expect(await retireStaleLaneDelegationRequests(db, { now: NOW })).toBe(3);
		const open = await db.all<{ id: string }>(
			"SELECT id FROM work_interactions WHERE status = 'open' ORDER BY id",
		);
		expect(open).toEqual([{ id: "current" }]);
		expect(
			await settleLaneDelegationRequests(db, {
				orgId: "org",
				workItemId: "work",
				workVersion: 3,
				targetType: "user",
				targetId: "owner",
				now: NOW,
			}),
		).toMatchObject({ retired: 0, existing: { id: "current" } });
	});
});
