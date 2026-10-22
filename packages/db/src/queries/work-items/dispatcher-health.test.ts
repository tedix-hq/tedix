import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import {
	DISPATCHER_HEALTH_SCHEMA,
	listDispatcherHealthOrgs,
	readDispatcherActivity,
} from "./dispatcher-health";

const T0 = "2026-10-21T20:00:00.000Z";
const T1 = "2026-10-21T21:00:00.000Z";

function seed() {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	// Admission machinery is out of scope here; only the attempt row matters.
	sqlite.exec("DROP TRIGGER work_attempt_admission_insert_guard");
	sqlite.exec(`
		INSERT INTO organizations(id,name,slug,metadata) VALUES('busy','Busy','busy','{"dispatcherHealth":{"staleAfterMinutes":10}}');
		INSERT INTO organizations(id,name,slug) VALUES('idle','Idle','idle');
		INSERT INTO policy_packs(id,organization_id,name,slug,status,version,definition) VALUES('pp-old','busy','P','p','active',1,'{}');
		INSERT INTO policy_packs(id,organization_id,name,slug,status,version,definition) VALUES('pp','busy','P','p','active',2,'{"kernelRequestCoordinator":{"enabled":true}}');
		INSERT INTO users(id,email) VALUES('owner','owner@example.com');
		INSERT INTO organization_members(id,organization_id,descope_user_id,user_id,email,role,status) VALUES('m1','busy','owner','owner','owner@example.com','owner','active');
	`);
	const item = sqlite.prepare(
		"INSERT INTO work_items(id,org_id,title,disposition,metadata,created_at,admission_spec_revision) VALUES(?,?,?,?,?,?,'revision-1')",
	);
	item.run("ready", "busy", "Ready", "accepted", '{"executor":"codex"}', T0);
	item.run(
		"ready2",
		"busy",
		"Ready too",
		"accepted",
		'{"executor":"codex","laneDispatch":{"state":"ready"}}',
		T1,
	);
	item.run(
		"blocked",
		"busy",
		"Blocked",
		"accepted",
		'{"executor":"codex","laneDispatch":{"state":"blocked"}}',
		T0,
	);
	item.run("noexec", "busy", "No executor", "accepted", "{}", T0);
	item.run(
		"proposed",
		"busy",
		"Proposed",
		"proposed",
		'{"executor":"codex"}',
		T0,
	);
	item.run(
		"running",
		"busy",
		"Running",
		"accepted",
		'{"executor":"codex"}',
		T0,
	);
	sqlite
		.prepare(
			"INSERT INTO work_attempts(id,work_item_id,org_id,executor_type,executor_id,runtime_state,attempt_number,started_at,heartbeat_at) VALUES(?,?,?,?,?,?,?,?,?)",
		)
		.run("a1", "running", "busy", "tedi", "x", "running", 1, T1, T1);
	return sqlite;
}

describe("dispatcher health queries", () => {
	it("lists only orgs with dispatchable Work and reports exact facts", async () => {
		const sqlite = seed();
		const db = createDbQueryClient(createD1Facade(sqlite));
		const rows = await listDispatcherHealthOrgs(db);
		expect(rows).toEqual([
			expect.objectContaining({
				orgId: "busy",
				trackerEnabled: true,
				dispatchableCount: 2,
				workItemId: "ready",
				staleAfterMinutes: 10,
				alarmEnabled: true,
				ownerUserId: "owner",
				lastAdmissionAt: T1,
				lastTrackerActionAt: null,
				openAlertId: null,
			}),
		]);
	});

	it("reports an open alert even after the Work is gone", async () => {
		const sqlite = seed();
		sqlite.exec(`UPDATE work_items SET disposition='completed'`);
		sqlite
			.prepare(
				"INSERT INTO work_interactions(id,org_id,work_item_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,created_at,metadata) VALUES('alert','busy','ready','coordination','S','P','user','owner','user','owner',?,?)",
			)
			.run(T1, JSON.stringify({ schema: DISPATCHER_HEALTH_SCHEMA }));
		const db = createDbQueryClient(createD1Facade(sqlite));
		expect(await listDispatcherHealthOrgs(db)).toEqual([
			expect.objectContaining({
				orgId: "busy",
				dispatchableCount: 0,
				openAlertId: "alert",
				openAlertCreatorId: "owner",
			}),
		]);
	});

	it("reports when the owner last answered an alert", async () => {
		const sqlite = seed();
		// Lifecycle guards are out of scope; only the stored status matters.
		for (const { name } of sqlite
			.prepare(
				"SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='work_interactions'",
			)
			.all() as { name: string }[])
			sqlite.exec(`DROP TRIGGER "${name}"`);
		const alert = sqlite.prepare(
			"INSERT INTO work_interactions(id,org_id,work_item_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,created_at,metadata,status,version) VALUES(?,'busy','ready','coordination','S','P','user','owner','user','owner',?,?,?,?)",
		);
		const metadata = JSON.stringify({ schema: DISPATCHER_HEALTH_SCHEMA });
		alert.run("answered-old", T0, metadata, "resolved", 2);
		alert.run("answered", T1, metadata, "resolved", 2);
		alert.run("cleared", T1, metadata, "cancelled", 2);
		alert.run("open", T1, metadata, "open", 3);
		const db = createDbQueryClient(createD1Facade(sqlite));
		expect(await listDispatcherHealthOrgs(db)).toEqual([
			expect.objectContaining({
				orgId: "busy",
				openAlertId: "open",
				openAlertVersion: 3,
				openAlertCreatorId: "owner",
				answeredAlertAt: T1,
			}),
		]);
	});

	it("skips an org without the request tracker unless it has an open alert", async () => {
		const sqlite = seed();
		sqlite.exec(`
			INSERT INTO organizations(id,name,slug) VALUES('plain','Plain','plain');
			INSERT INTO organization_members(id,organization_id,descope_user_id,user_id,email,role,status) VALUES('m2','plain','owner','owner','owner@example.com','owner','active');
			INSERT INTO work_items(id,org_id,title,disposition,metadata,created_at,admission_spec_revision)
				VALUES('plain-ready','plain','Ready','accepted','{"executor":"codex"}','${T0}','revision-1');
		`);
		const db = createDbQueryClient(createD1Facade(sqlite));
		expect((await listDispatcherHealthOrgs(db)).map((r) => r.orgId)).toEqual([
			"busy",
		]);
		sqlite
			.prepare(
				"INSERT INTO work_interactions(id,org_id,work_item_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,created_at,metadata) VALUES('stuck','plain','plain-ready','coordination','S','P','user','owner','user','owner',?,?)",
			)
			.run(T1, JSON.stringify({ schema: DISPATCHER_HEALTH_SCHEMA }));
		expect(await listDispatcherHealthOrgs(db)).toEqual([
			expect.objectContaining({ orgId: "busy", trackerEnabled: true }),
			expect.objectContaining({
				orgId: "plain",
				trackerEnabled: false,
				openAlertId: "stuck",
			}),
		]);
	});

	it("reads the newest signals by index seek, never a table scan", async () => {
		const sqlite = seed();
		sqlite.exec(`
			WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<22000)
			INSERT INTO work_items(id,org_id,title,disposition,metadata,created_at,admission_spec_revision)
			SELECT 'held-'||i,'busy','Held','accepted',
				'{"executor":"codex","laneDispatch":{"state":"held"}}',
				'2026-10-20T00:00:00Z','revision-1' FROM n;
			ANALYZE work_items;
		`);
		const statements: string[] = [];
		const prepare = sqlite.prepare.bind(sqlite);
		sqlite.prepare = ((text: string) => {
			statements.push(text);
			return prepare(text);
		}) as typeof sqlite.prepare;
		const db = createDbQueryClient(createD1Facade(sqlite));
		await listDispatcherHealthOrgs(db);
		await readDispatcherActivity(db);
		const plans = statements
			.filter((text) => text.includes("kernel_requests"))
			.map((text) =>
				(
					prepare(`EXPLAIN QUERY PLAN ${text}`).all(
						...Array.from(text.matchAll(/\?/g), () => null),
					) as { detail: string }[]
				)
					.map((row) => row.detail)
					.join("\n"),
			);
		expect(plans).toHaveLength(2);
		for (const plan of plans) {
			expect(plan).toContain(
				"SEARCH a USING COVERING INDEX idx_work_attempt_org_started (org_id=?)",
			);
			expect(plan).toContain(
				"SEARCH k USING COVERING INDEX kernel_requests_updated_idx (organization_id=?)",
			);
			expect(plan).toContain(
				"SEARCH p USING INDEX idx_policy_packs_org (organization_id=?)",
			);
			expect(plan).not.toMatch(/SCAN (a|k|p|w|h|m)\b/);
		}
		const workSearches = plans[0]?.match(/SEARCH w [^\n]+/g) ?? [];
		expect(workSearches.length).toBeGreaterThanOrEqual(3);
		for (const search of workSearches) {
			expect(search).toContain("idx_work_items_lane_ready");
		}
	});

	it("exposes only the two platform timestamps", async () => {
		const sqlite = seed();
		const db = createDbQueryClient(createD1Facade(sqlite));
		expect(await readDispatcherActivity(db)).toEqual({
			lastAdmissionAt: T1,
			lastTrackerActionAt: null,
		});
		sqlite.exec("UPDATE policy_packs SET definition='{}'");
		expect(await readDispatcherActivity(db)).toEqual({
			lastAdmissionAt: null,
			lastTrackerActionAt: null,
		});
	});
});
