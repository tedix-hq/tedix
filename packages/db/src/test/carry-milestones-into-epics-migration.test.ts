import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createMigratedSqlite } from "./migrated-sqlite";

const NAME = "20261115203018_carry_milestones_into_epics";
const migration = readFileSync(
	new URL(`../../drizzle/${NAME}/migration.sql`, import.meta.url),
	"utf8",
);
const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const T0 = "2026-10-01T00:00:00.000Z";
const T1 = "2026-10-02T00:00:00.000Z";
const TARGET = "2026-12-01T00:00:00.000Z";

/** The production schema and triggers as they stand just before the migration. */
function before(): DatabaseSync {
	return createMigratedSqlite({ beforeMigration: NAME });
}

function all(db: DatabaseSync, sql: string) {
	return db
		.prepare(sql)
		.all()
		.map((row) => ({ ...row }));
}

function counts(db: DatabaseSync) {
	return Object.fromEntries(
		["work_cases", "work_case_items", "work_case_dependencies"].map((table) => [
			table,
			Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n),
		]),
	);
}

function seed(db: DatabaseSync) {
	const milestone = (id: string, status: string, owner: string, extra = "") =>
		`INSERT INTO work_milestones(id,org_id,project_id,title,description,status,accountable_owner_type,accountable_owner_id,sort_order,target_at,created_at) VALUES('${id}','org','project','${id} title',${extra || "NULL"},'${status}',${owner},3,'${TARGET}','${T0}');`;
	const link = (milestoneId: string, workItemId: string) =>
		`INSERT INTO work_milestone_items(org_id,milestone_id,work_item_id,created_at) VALUES('org','${milestoneId}','${workItemId}','${T0}');`;
	db.exec(`
		INSERT INTO organizations(id,name,slug) VALUES('org','Org','org');
		INSERT INTO users(id,email) VALUES('user','user@example.com'),('gone','gone@example.com');
		INSERT INTO organization_members(id,organization_id,descope_user_id,user_id,email,status) VALUES
			('member','org','user','user','user@example.com','active'),
			('member-gone','org','gone','gone','gone@example.com','active');
		INSERT INTO projects(id,org_id,key,name,created_at) VALUES('project','org','project','Project','${T0}');
		INSERT INTO work_items(id,org_id,project_id,title,disposition,admission_spec_revision,created_at) VALUES
			('finished','org','project','Finished','completed','r1','${T0}'),
			('finished-too','org','project','Finished too','completed','r1','${T0}'),
			('open','org','project','Open','proposed','r1','${T0}');
		${milestone("proposed", "proposed", "'user','user'", "'Why it matters'")}
		${milestone("planned", "planned", "'user','gone'")}
		${milestone("active", "active", "'system','tedix'")}
		${milestone("done", "active", "'user','user'")}
		${milestone("cancelled", "active", "'user','user'", "'Dropped scope'")}
		${milestone("cancelled-bare", "planned", "'user','user'")}
		${link("active", "open")}
		${link("done", "finished")}
		${link("cancelled", "finished-too")}
		${link("cancelled", "open")}
		INSERT INTO work_milestone_dependencies(id,org_id,prerequisite_milestone_id,dependent_milestone_id,created_at) VALUES
			('dependency','org','done','active','${T0}'),
			('dependency-2','org','proposed','planned','${T0}');
		UPDATE work_milestones SET status='done',proof_ref='https://example.test/proof',done_at='${T1}',updated_at='${T1}',version=2 WHERE id='done';
		UPDATE work_milestones SET status='cancelled',cancelled_at='${T1}',updated_at='${T1}',version=2 WHERE id IN ('cancelled','cancelled-bare');
		UPDATE organization_members SET status='suspended' WHERE id='member-gone';
		INSERT INTO work_sprints(id,org_id,project_id,name,start_at,end_at,created_at) VALUES('sprint','org','project','Sprint','${T0}','${T1}','${T0}');
		INSERT INTO work_sprint_items(org_id,sprint_id,work_item_id,created_at) VALUES('org','sprint','open','${T0}');
	`);
}

describe("carry milestones into epics migration", () => {
	it("does nothing on empty tables, twice", () => {
		const db = before();
		db.exec(migration);
		db.exec(migration);
		expect(counts(db)).toEqual({
			work_cases: 0,
			work_case_items: 0,
			work_case_dependencies: 0,
		});
	});

	it("turns each milestone into one epic with its date, owner, proof, links and stage", () => {
		const db = before();
		seed(db);
		db.exec(migration);
		const epics = all(
			db,
			"SELECT id,project_id,title,description,kind,stage,accountable_owner_type AS owner_type,accountable_owner_id AS owner_id,opened_at,target_resolution_at AS target,proof_ref,closed_at,version,json_extract(metadata,'$.carriedFrom.status') AS was,json_extract(metadata,'$.carriedFrom.ownerId') AS was_owner,json_extract(metadata,'$.carriedFrom.openWorkItemIdsLeftOff') AS left_off FROM work_cases ORDER BY id",
		);
		const shared = {
			project_id: "project",
			kind: "other",
			opened_at: T0,
			target: TARGET,
		};
		expect(epics).toEqual([
			{
				...shared,
				id: "active",
				title: "active title",
				description: null,
				stage: "executing",
				owner_type: "system",
				owner_id: "tedix",
				proof_ref: null,
				closed_at: null,
				version: 1,
				was: "active",
				was_owner: "tedix",
				left_off: "[]",
			},
			{
				...shared,
				id: "cancelled",
				title: "cancelled title",
				description:
					"Cancelled milestone, carried over as a closed epic.\n\nDropped scope",
				stage: "closed",
				owner_type: "user",
				owner_id: "user",
				proof_ref: null,
				closed_at: T1,
				version: 2,
				was: "cancelled",
				was_owner: "user",
				left_off: '["open"]',
			},
			{
				...shared,
				id: "cancelled-bare",
				title: "cancelled-bare title",
				description: "Cancelled milestone, carried over as a closed epic.",
				stage: "closed",
				owner_type: "user",
				owner_id: "user",
				proof_ref: null,
				closed_at: T1,
				version: 2,
				was: "cancelled",
				was_owner: "user",
				left_off: "[]",
			},
			{
				...shared,
				id: "done",
				title: "done title",
				description: null,
				stage: "closed",
				owner_type: "user",
				owner_id: "user",
				proof_ref: "https://example.test/proof",
				closed_at: T1,
				version: 2,
				was: "done",
				was_owner: "user",
				left_off: "[]",
			},
			{
				...shared,
				id: "planned",
				title: "planned title",
				description: null,
				stage: "planning",
				// The owner left the organization, so the epic falls to the system.
				owner_type: "system",
				owner_id: "tedix",
				proof_ref: null,
				closed_at: null,
				version: 1,
				was: "planned",
				was_owner: "gone",
				left_off: "[]",
			},
			{
				...shared,
				id: "proposed",
				title: "proposed title",
				description: "Why it matters",
				stage: "planning",
				owner_type: "user",
				owner_id: "user",
				proof_ref: null,
				closed_at: null,
				version: 1,
				was: "proposed",
				was_owner: "user",
				left_off: "[]",
			},
		]);

		const links = all(
			db,
			"SELECT id,case_id,work_item_id,discovered_at FROM work_case_items ORDER BY case_id,work_item_id",
		);
		expect(links.map(({ id: _id, ...link }) => link)).toEqual([
			{ case_id: "active", work_item_id: "open", discovered_at: T0 },
			// The cancelled milestone's open task is left off its closed epic.
			{
				case_id: "cancelled",
				work_item_id: "finished-too",
				discovered_at: T0,
			},
			{ case_id: "done", work_item_id: "finished", discovered_at: T0 },
		]);
		const dependencies = all(
			db,
			"SELECT id,prerequisite_case_id AS first,dependent_case_id AS next FROM work_case_dependencies ORDER BY first",
		);
		expect(dependencies.map(({ id: _id, ...edge }) => edge)).toEqual([
			{ first: "done", next: "active" },
			{ first: "proposed", next: "planned" },
		]);
		for (const row of [...links, ...dependencies]) expect(row.id).toMatch(UUID);
		expect(new Set(links.map((row) => row.id)).size).toBe(links.length);

		// Milestones and sprints stay in place until a later migration drops them.
		expect(
			db.prepare("SELECT count(*) AS n FROM work_milestones").get()!.n,
		).toBe(6);
		expect(
			db.prepare("SELECT count(*) AS n FROM work_sprint_items").get()!.n,
		).toBe(1);
	});

	it("can run again without duplicates or errors", () => {
		const db = before();
		seed(db);
		db.exec(migration);
		const first = counts(db);
		const rows = all(db, "SELECT * FROM work_cases ORDER BY id");
		db.exec(migration);
		expect(counts(db)).toEqual(first);
		expect(all(db, "SELECT * FROM work_cases ORDER BY id")).toEqual(rows);
		expect(first).toEqual({
			work_cases: 6,
			work_case_items: 3,
			work_case_dependencies: 2,
		});
	});

	it("keeps a done milestone open when one of its tasks is no longer finished", () => {
		const db = before();
		seed(db);
		// Bypass the Work Item lifecycle to model a row that drifted after Done.
		const triggers = all(
			db,
			"SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='work_items'",
		);
		for (const { name } of triggers) db.exec(`DROP TRIGGER "${String(name)}"`);
		db.exec("UPDATE work_items SET disposition='accepted' WHERE id='finished'");
		db.exec(migration);
		expect(
			all(
				db,
				"SELECT stage,closed_at,proof_ref FROM work_cases WHERE id='done'",
			),
		).toEqual([
			{
				stage: "monitoring",
				closed_at: null,
				proof_ref: "https://example.test/proof",
			},
		]);
	});

	it("leaves existing epics as they were", () => {
		const db = before();
		seed(db);
		db.exec(
			`INSERT INTO work_cases(id,org_id,title,kind,stage,accountable_owner_type,accountable_owner_id,opened_at,created_at) VALUES('existing','org','Existing','incident','investigating','system','tedix','${T0}','${T0}')`,
		);
		const existing = all(db, "SELECT * FROM work_cases WHERE id='existing'");
		db.exec(migration);
		expect(all(db, "SELECT * FROM work_cases WHERE id='existing'")).toEqual(
			existing,
		);
	});
});
