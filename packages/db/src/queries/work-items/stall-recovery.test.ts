import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import { createD1Facade } from "../../test/d1-facade";
import {
	advanceStallRecoveryCheckpoint,
	getStallRecoveryCheckpoint,
	listContinuityScopes,
} from "./stall-recovery";

const sqlite = new DatabaseSync(":memory:");
let query = "";
const db = createDbClient(
	createD1Facade(sqlite, {
		onPrepare(sql) {
			query = sql;
		},
	}),
);
beforeAll(() => {
	const root = new URL("../../../drizzle/", import.meta.url);
	for (const name of readdirSync(root).sort())
		sqlite.exec(readFileSync(new URL(`${name}/migration.sql`, root), "utf8"));
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(`INSERT INTO tedis(id,organization_id,name,slug,status) VALUES ('owner','fictional-orchard','Owner','owner','active');
 INSERT INTO tedi_objectives(id,org_id,tedi_id,title,created_at) VALUES ('a','fictional-orchard','owner','Standalone','2026-10-01'),('covered','fictional-orchard','owner','Covered','2026-10-01');
 INSERT INTO projects(id,org_id,key,name,objective_id,created_at) VALUES ('a','fictional-orchard','A','Project','covered','2026-10-01'),('z','fictional-forest','Z','Foreign',NULL,'2026-10-01');`);
});
afterAll(() => sqlite.close());

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
			await listContinuityScopes(db, after, org);
			const plan = sqlite
				.prepare(`EXPLAIN QUERY PLAN ${query}`)
				.all(...Array(query.match(/\?/g)?.length ?? 0).fill("")) as {
				detail: string;
			}[];
			const details = plan.map((p) => p.detail).join("\n");
			expect(details).not.toMatch(/SCAN (?:p|o|r|g|k|t|c)\b/);
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
				"os_gadget_executions_org_workspace_environment_idx",
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
