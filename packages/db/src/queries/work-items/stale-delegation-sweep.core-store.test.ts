import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { DbClient } from "../../client";
import { createPGliteFacade } from "../../test/pglite-facade";
import { workInteractionStoredColumns } from "../../schema/work-factory";
import { workItems, workItemStoredColumns } from "../../schema/work-items";
import { workInteractions } from "../../schema/work-factory";
import { getScopedWorkItem, selectedStoredColumns } from "./factory-state";
import { requireActivePrincipal } from "./factory-validation";
import {
	STALE_FAILED_DELEGATION_REASON,
	sweepStaleFailedDelegationWorkItems,
	sweepUncontractedChildWorkItems,
} from "./stale-delegation-sweep";
import { resolveWorkItemSteward } from "./stewardship";

const now = "2026-10-09T12:00:00.000Z";
const old = "2026-10-01T12:00:00.000Z";

// The sweeps' raw predicates and the stored-column selections on Postgres.
describe("stale delegation sweeps on postgres", () => {
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
			INSERT INTO organizations(id,name,slug,metadata)
			VALUES ('org','Org','org','{"workStewardship":{"enabled":true,"defaultTediId":"00000000-0000-4000-8000-000000000001","projectStewards":{},"workKindStewards":{},"useProjectLead":false}}');
			INSERT INTO tedis(id,organization_id,name,slug,status)
			VALUES ('00000000-0000-4000-8000-000000000001','org','Steward','steward','active');
			INSERT INTO work_items(id,org_id,title,disposition,provenance,metadata,delegation_root_id,created_at,updated_at)
			VALUES ('failed','org','Failed child','accepted','{"source":"kernelRuntime.directDelegation"}','{}',NULL,'${old}','${old}'),
				('contracted','org','Contracted child','accepted','{}','{}','root','${old}','${old}'),
				('uncontracted','org','Uncontracted child','accepted','{}','{}','root','${old}','${old}');
			INSERT INTO work_attempts(id,work_item_id,org_id,executor_type,executor_id,runtime_state,outcome,attempt_number,started_at,heartbeat_at,finished_at)
			VALUES ('attempt','failed','org','tedi','steward','failed','failed',1,'${old}','${old}','${old}');
			INSERT INTO work_events(id,org_id,work_item_id,event_type,actor_type,actor_id,payload,occurred_at)
			VALUES ('contracted','org','contracted','work.created','system','tedix','{"taskContract":{}}','${old}');
		`);
	});
	afterAll(() => close());

	it("selects stored columns that exist on the Postgres tables", () => {
		for (const [table, stored] of [
			[workItems, workItemStoredColumns],
			[workInteractions, workInteractionStoredColumns],
		] as const)
			expect(
				Object.values(selectedStoredColumns(db, table, stored)),
			).not.toContain(undefined);
	});

	it("cancels only abandoned delegations and uncontracted children", async () => {
		expect(
			await sweepStaleFailedDelegationWorkItems(db, { now }),
		).toMatchObject({ observed: 1, cancelled: 1 });
		expect(await getScopedWorkItem(db, "org", "failed")).toMatchObject({
			disposition: "cancelled",
		});
		expect(await sweepUncontractedChildWorkItems(db, { now })).toMatchObject({
			observed: 1,
			cancelled: 1,
		});
		expect(await getScopedWorkItem(db, "org", "contracted")).toMatchObject({
			disposition: "accepted",
		});
		expect(await getScopedWorkItem(db, "org", "uncontracted")).toMatchObject({
			disposition: "cancelled",
		});
		expect(STALE_FAILED_DELEGATION_REASON).toBe("stale_failed_delegation");
	});

	it("reads principals and the jsonb stewardship policy", async () => {
		await requireActivePrincipal(db, {
			orgId: "org",
			type: "tedi",
			id: "00000000-0000-4000-8000-000000000001",
		});
		expect(
			await resolveWorkItemSteward(db, { orgId: "org", workKind: "other" }),
		).toEqual({
			stewardType: "tedi",
			stewardId: "00000000-0000-4000-8000-000000000001",
		});
	});
});
