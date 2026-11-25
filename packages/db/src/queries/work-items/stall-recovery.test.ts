import { createMigratedSqlite } from "../../test/migrated-sqlite";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import { createD1Facade } from "../../test/d1-facade";
import {
	advanceStallRecoveryCheckpoint,
	getStallRecoveryCheckpoint,
	listContinuityScopes,
	readStallRecoveryPage,
	type StallRecoveryCursor,
} from "./stall-recovery";

const sqlite = createMigratedSqlite();
let queries: string[] = [];
const db = createDbClient(
	createD1Facade(sqlite, {
		onPrepare(sql) {
			queries.push(sql);
		},
	}),
);
/** The statement that reads the history outside Work, apart from the Work statement. */
const isHistory = (sql: string) => sql.includes("os_gadget_executions");

it("keeps configured empty scopes and drains legacy pages without recounting Work", async () => {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	const db = createDbClient(createD1Facade(sqlite));
	for (let i = 0; i < 12; i++) {
		const id = `p-${String(i).padStart(2, "0")}`;
		sqlite
			.prepare(
				"INSERT INTO projects(id,org_id,key,name,created_at) VALUES(?,'orchard',?,?,'2026-10-01')",
			)
			.run(id, id, id);
		sqlite
			.prepare(
				"INSERT INTO work_items(id,org_id,project_id,title,disposition,admission_spec_revision,created_at) VALUES(?,'orchard',?,?,'proposed','revision-1','2026-10-01')",
			)
			.run(`w-${id}`, id, "Pending");
	}
	sqlite.exec(`INSERT INTO projects(id,org_id,key,name,created_at,metadata) VALUES
		('empty','forest','EMPTY','Empty','2026-10-01','{}'),
		('promise','forest','PROMISE','Promise','2026-10-01','{"continuity":{"cadence":{"everyHours":24,"minResults":1,"description":"Daily result"}}}');
		INSERT INTO tedi_objectives(id,org_id,tedi_id,title,created_at,gate_config) VALUES
		('goal','forest','owner','Goal','2026-10-01','{"continuity":{"idleHours":24}}');`);
	const all = await listContinuityScopes(db);
	const expected = all.filter((s) => s.pendingCount > 0 || s.policy !== null);
	let cursor: StallRecoveryCursor = { after: "" };
	const observed = [];
	do {
		const { scopes, ...next } = await readStallRecoveryPage(
			db,
			cursor,
			"production",
		);
		expect(scopes.length).toBeLessThanOrEqual(5);
		observed.push(...scopes);
		cursor = JSON.parse(JSON.stringify(next));
	} while (cursor.after || cursor.pending?.length);
	expect(observed).toEqual(expected);
	// Old checkpoints may leave many completed slices alongside unfinished
	// Work. Completed slices must be delivered once, not read again from row 0.
	cursor = {
		after: "project:promise",
		atEnd: true,
		pending: expected.map((scope) => ({
			...scope,
			workEnd: null,
			objectiveId: null,
		})),
	};
	const legacy = [];
	do {
		const { scopes, ...next } = await readStallRecoveryPage(
			db,
			cursor,
			"production",
		);
		expect(scopes.length).toBeLessThanOrEqual(5);
		legacy.push(...scopes);
		cursor = JSON.parse(JSON.stringify(next));
	} while (cursor.after || cursor.pending?.length);
	expect(legacy).toEqual(expected);
	sqlite.close();
});

beforeAll(() => {
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(`INSERT INTO tedis(id,organization_id,name,slug,status) VALUES ('owner','fictional-orchard','Owner','owner','active');
 INSERT INTO tedi_objectives(id,org_id,tedi_id,title,created_at) VALUES ('a','fictional-orchard','owner','Standalone','2026-10-01'),('covered','fictional-orchard','owner','Covered','2026-10-01');
 INSERT INTO projects(id,org_id,key,name,objective_id,created_at) VALUES ('a','fictional-orchard','A','Project','covered','2026-10-01'),('z','fictional-forest','Z','Foreign',NULL,'2026-10-01');`);
});

describe("migrated stall recovery", () => {
	it("keeps compound key order, skips covered objectives, and scopes tenants", async () => {
		expect((await listContinuityScopes(db)).map((s) => s.key)).toEqual([
			"objective:a",
			"project:a",
			"project:z",
		]);
		expect(
			(await listContinuityScopes(db, "objective:a")).map((s) => s.key),
		).toEqual(["project:a", "project:z"]);
		expect(
			(await listContinuityScopes(db, "project:a", "fictional-orchard")).map(
				(s) => s.key,
			),
		).toEqual([]);
		expect(
			(await listContinuityScopes(db, "", "fictional-orchard")).map(
				(s) => s.key,
			),
		).toEqual(["objective:a", "project:a"]);
	});
	it.each([
		[undefined, ""],
		["fictional-orchard", ""],
		[undefined, "objective:a"],
		["fictional-orchard", "objective:a"],
		[undefined, "project:a"],
		["fictional-orchard", "project:a"],
	])(
		"seeks source and history indexes for org %s after %s",
		async (org, after) => {
			// The history statement has one text; a page with no scopes runs none.
			await listContinuityScopes(db);
			const history = queries.find(isHistory)!;
			queries = [];
			const scopes = await listContinuityScopes(db, after, org);
			expect(queries.filter(isHistory)).toHaveLength(scopes.length ? 1 : 0);
			const details = [...new Set([...queries, history])]
				.flatMap(
					(query) =>
						sqlite
							.prepare(`EXPLAIN QUERY PLAN ${query}`)
							.all(...Array(query.match(/\?/g)?.length ?? 0).fill("")) as {
							detail: string;
						}[],
				)
				.map((p) => p.detail)
				.join("\n");
			expect(details).not.toMatch(/SCAN (?:p|o|r|g|k|t|c|l)\b/);
			expect(details).toContain(
				"idx_projects_" + (org ? "org_status_id" : "status_id"),
			);
			expect(details).toContain(
				"idx_objectives_" + (org ? "org_status_id" : "status_id"),
			);
			expect(details).toContain("idx_projects_org_objective_status");
			expect(details).toContain("idx_skill_runs_org_work_environment");
			expect(details).toContain("idx_work_items_org_objective");
			expect(details).toContain("uniq_work_attempt_number");
			expect(details).toContain(
				"idx_os_gadget_executions_org_workspace_environment_latest",
			);
			expect(details).toContain("os_workspace_projects_org_project_status_idx");
		},
	);
	it("rejects stale checkpoint writes including wraparound", async () => {
		await advanceStallRecoveryCheckpoint(db, "production", null, "page-a");
		await advanceStallRecoveryCheckpoint(
			db,
			"production",
			null,
			"late-first-page",
		);
		expect(await getStallRecoveryCheckpoint(db, "production")).toBe("page-a");
		await advanceStallRecoveryCheckpoint(db, "production", "page-a", "wrapped");
		await advanceStallRecoveryCheckpoint(db, "production", "page-a", "stale");
		expect(await getStallRecoveryCheckpoint(db, "production")).toBe("wrapped");
		expect(await getStallRecoveryCheckpoint(db, "staging")).toBeNull();
	});
});
