import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import {
	CAPTURE_HEALTH_SCHEMA,
	getCaptureHealth,
	listCaptureHealth,
} from "./capture-health";

const migrationRoot = new URL("../../../drizzle/", import.meta.url);
const migrations = readdirSync(migrationRoot)
	.sort()
	.map((name) =>
		readFileSync(new URL(`${name}/migration.sql`, migrationRoot), "utf8"),
	);

const OLD = "2026-08-10T00:00:00.000Z";
const SINCE = "2026-08-20T00:00:00.000Z";
const RECENT = "2026-08-20T06:00:00.000Z";
const NOW = "2026-08-21T00:00:00.000Z";

function seed() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=ON");
	for (const sqlText of migrations) sqlite.exec(sqlText);
	sqlite.exec(`
		INSERT INTO organizations(id,name,slug) VALUES('org','Org','org');
		INSERT INTO users(id,email) VALUES('busy','busy@example.com');
		INSERT INTO users(id,email) VALUES('quiet','quiet@example.com');
		INSERT INTO organization_members(id,organization_id,descope_user_id,user_id,email,status) VALUES('m1','org','busy','busy','busy@example.com','active');
		INSERT INTO organization_members(id,organization_id,descope_user_id,user_id,email,status) VALUES('m2','org','quiet','quiet','quiet@example.com','active');
		INSERT INTO work_items(id,org_id,title,disposition,work_class,purpose_exception_expires_at,admission_spec_revision,created_at) VALUES('work','org','Work','completed','hygiene','2026-09-01T00:00:00.000Z','revision-1','${OLD}');
		INSERT INTO tedis(id,organization_id,name,slug,status) VALUES('drafter','org','Drafter','drafter','active');
	`);
	const ask = sqlite.prepare(
		"INSERT INTO work_interactions(id,org_id,work_item_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,created_at,expires_at,metadata) VALUES(?,'org','work','question','Q','A?','system','tedix','user',?,?,?,?)",
	);
	const capture = JSON.stringify({
		schema: "tedix.decision-capture.v1",
		triage: { status: "ok", urgency: "later", labels: {}, urgentLabels: [] },
	});
	ask.run("busy-old", "busy", OLD, null, capture);
	ask.run("busy-new", "busy", RECENT, null, capture);
	ask.run("quiet-old", "quiet", OLD, null, capture);
	ask.run(
		"quiet-alert",
		"quiet",
		RECENT,
		"2026-08-22T00:00:00.000Z",
		JSON.stringify({ schema: CAPTURE_HEALTH_SCHEMA }),
	);
	sqlite.exec(`
		INSERT INTO work_interaction_reply_drafts(id,org_id,interaction_id,drafter_type,drafter_id,body,rationale,created_at) VALUES('d1','org','busy-old','tedi','drafter','Go','Because','${RECENT}');
		INSERT INTO learning_interaction_events(id,organization_id,actor_type,actor_id,client_event_id,signal_class,event_kind,scope_kind,scope_id,surface,occurred_at) VALUES('e1','org','user','quiet','c1','lifecycle','delivered','organization','org','lesson_delivery','${RECENT}');
	`);
	return createDbQueryClient(createD1Facade(sqlite));
}

describe("capture health", () => {
	it("counts one user's turns, drafts and lessons since a time", async () => {
		const db = seed();
		expect(
			await getCaptureHealth(db, {
				orgId: "org",
				userId: "busy",
				since: SINCE,
			}),
		).toEqual({ turns: 1, drafts: 1, lessons: 0 });
	});

	it("lists users with capture on and whether a health item is open", async () => {
		const db = seed();
		expect(
			await listCaptureHealth(db, { since: SINCE, activeSince: OLD, now: NOW }),
		).toEqual([
			{
				orgId: "org",
				userId: "busy",
				projectId: null,
				workItemId: "work",
				caseId: null,
				alertOpen: false,
				turns: 1,
				drafts: 1,
				lessons: 0,
			},
			{
				orgId: "org",
				userId: "quiet",
				projectId: null,
				workItemId: "work",
				caseId: null,
				alertOpen: true,
				turns: 0,
				drafts: 0,
				lessons: 1,
			},
		]);
	});
});
