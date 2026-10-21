import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import {
	DISPATCHER_HEALTH_SCHEMA,
	listDispatcherHealthOrgs,
	readDispatcherActivity,
} from "./dispatcher-health";

const migrationRoot = new URL("../../../drizzle/", import.meta.url);
const migrations = readdirSync(migrationRoot)
	.sort()
	.map((name) =>
		readFileSync(new URL(`${name}/migration.sql`, migrationRoot), "utf8"),
	);

const T0 = "2026-10-21T20:00:00.000Z";
const T1 = "2026-10-21T21:00:00.000Z";

function seed() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	for (const sqlText of migrations) sqlite.exec(sqlText);
	// Admission machinery is out of scope here; only the attempt row matters.
	sqlite.exec("DROP TRIGGER work_attempt_admission_insert_guard");
	sqlite.exec(`
		INSERT INTO organizations(id,name,slug,metadata) VALUES('busy','Busy','busy','{"dispatcherHealth":{"staleAfterMinutes":10}}');
		INSERT INTO organizations(id,name,slug) VALUES('idle','Idle','idle');
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

	it("exposes only the two platform timestamps", async () => {
		const sqlite = seed();
		const db = createDbQueryClient(createD1Facade(sqlite));
		expect(await readDispatcherActivity(db)).toEqual({
			lastAdmissionAt: T1,
			lastTrackerActionAt: null,
		});
	});
});
