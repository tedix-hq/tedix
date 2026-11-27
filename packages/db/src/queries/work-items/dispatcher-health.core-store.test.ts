import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { DbClient } from "../../client";
import { createPGliteFacade } from "../../test/pglite-facade";
import {
	advanceDispatcherHealthPage,
	listDispatcherHealthOrgs,
	readDispatcherActivity,
	readDispatcherHealthPage,
} from "./dispatcher-health";
import { getWorkFleetProjection } from "./fleet";

const now = "2026-10-22T08:00:00.000Z";
const started = "2026-10-22T07:00:00.000Z";

// D1 runs these in dispatcher-health.test.ts; this covers the Postgres dialect paths.
describe("dispatcher health on Postgres", () => {
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
			INSERT INTO organizations(id,name,slug,metadata) VALUES ('org','Org','org',
				'{"dispatcherHealth":{"enabled":false,"alarmIntervalMinutes":30,"staleAfterMinutes":20}}');
			INSERT INTO policy_packs(id,organization_id,name,slug,status,version,definition)
			VALUES ('pack','org','Pack','pack','active',1,'{"kernelRequestCoordinator":{"enabled":true}}');
			INSERT INTO work_items(id,org_id,title,created_at,accepted_at,disposition,accountable_owner_type,accountable_owner_id,executor_id,dispatch_state)
			VALUES ('ready','org','Ready','${now}','${now}','accepted','user','owner','codex','ready'),
				('busy','org','Busy','${now}','${now}','accepted','user','owner','codex','ready');
			INSERT INTO work_attempts(id,org_id,work_item_id,attempt_number,executor_type,executor_id,executor_session_id,external_session_key,runtime_state,started_at,heartbeat_at,expires_at)
			VALUES ('attempt','org','busy',1,'external_agent','codex','session','session-key','running','${started}','${started}','2026-10-22T09:00:00.000Z');
		`);
	});
	afterAll(() => close());

	it("reads tracker policy, org settings and dispatchable Work", async () => {
		expect(await listDispatcherHealthOrgs(db)).toEqual([
			expect.objectContaining({
				orgId: "org",
				trackerEnabled: true,
				staleAfterMinutes: 20,
				alarmIntervalMinutes: 30,
				alarmEnabled: false,
				dispatchableCount: 1,
				workItemId: "ready",
				lastAdmissionAt: started,
			}),
		]);
		expect(await readDispatcherActivity(db)).toEqual({
			lastAdmissionAt: started,
			lastTrackerActionAt: null,
		});
	});

	it("pages and advances epoch-millisecond checkpoints", async () => {
		const scheduledTime = Date.parse(now);
		const page = await readDispatcherHealthPage(db, "test", scheduledTime);
		expect(page.cadenceChecks).toEqual([
			{
				scheduleId: "dispatcher-health:test:org",
				through: String(scheduledTime),
			},
		]);
		await advanceDispatcherHealthPage(db, page);
		await advanceDispatcherHealthPage(db, {
			...page,
			previous: page.next,
			cadenceChecks: page.cadenceChecks!.map((check) => ({
				...check,
				through: String(scheduledTime + 60_000),
			})),
		});
		const next = await readDispatcherHealthPage(
			db,
			"test",
			scheduledTime + 120_000,
		);
		// The org's 30-minute cadence is not due two minutes after its last check.
		expect(next.rows).toEqual([]);
	});

	it("groups fleet counts by effective state", async () => {
		const fleet = await getWorkFleetProjection(db, { orgId: "org", now });
		expect(fleet.workItems).toEqual({
			total: 2,
			byDisposition: { accepted: 2 },
		});
		expect(fleet.attempts).toMatchObject({ total: 1, active: 1 });
	});
});
