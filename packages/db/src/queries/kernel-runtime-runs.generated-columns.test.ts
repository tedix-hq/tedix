import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { kernelRuntimeRuns } from "../schema/cognitive-runtime";
import { schemaDdl } from "../test/schema-ddl";
import { staleDelegationResolutionTakeoverGuard } from "./kernel-runtime-runs";
import { QueryBuilder } from "drizzle-orm/sqlite-core";

it("indexes run Work and delegated tedi metadata and fixes takeover paths in SQL", () => {
	const sqlite = new DatabaseSync(":memory:");
	try {
		sqlite.exec(schemaDdl(kernelRuntimeRuns));
		sqlite.exec("PRAGMA foreign_keys = OFF");
		sqlite.exec(`INSERT INTO kernel_runtime_runs(id,organization_id,conversation_id,status,metadata,created_at,updated_at) VALUES
			('run','org','conversation','requires_approval','{"workItemId":"work","homeDelegation":{"workOrder":{"targetTediId":"tedi"}}}','2026-11-18','2026-11-18')`);
		expect(
			sqlite
				.prepare("SELECT work_item_id,target_tedi_id FROM kernel_runtime_runs")
				.get(),
		).toEqual({ work_item_id: "work", target_tedi_id: "tedi" });
		for (const [query, index] of [
			[
				"SELECT id FROM kernel_runtime_runs WHERE organization_id='org' AND work_item_id='work' ORDER BY updated_at",
				"idx_kernel_runtime_runs_work_item",
			],
			[
				"SELECT id FROM kernel_runtime_runs WHERE organization_id='org' AND status='requires_approval' AND target_tedi_id='tedi' ORDER BY updated_at",
				"idx_kernel_runtime_runs_target_tedi",
			],
		]) {
			const plan = sqlite
				.prepare(`EXPLAIN QUERY PLAN ${query}`)
				.all()
				.map((row) => String(row.detail));
			expect(plan).toContainEqual(
				expect.stringContaining(`USING INDEX ${index}`),
			);
			expect(plan.some((row) => row.includes("TEMP B-TREE"))).toBe(false);
		}
		sqlite.exec(`UPDATE kernel_runtime_runs SET metadata='{}'`);
		expect(
			sqlite
				.prepare("SELECT work_item_id,target_tedi_id FROM kernel_runtime_runs")
				.get(),
		).toEqual({ work_item_id: null, target_tedi_id: null });
		const statement = new QueryBuilder()
			.select()
			.from(kernelRuntimeRuns)
			.where(
				staleDelegationResolutionTakeoverGuard({
					claimId: "claim",
					staleBefore: "2026-11-18",
				}),
			)
			.toSQL();
		expect(statement.sql).toContain("'$.homeDelegationResolutionClaim.phase'");
		expect(statement.sql).toContain(
			"'$.homeDelegationResolutionClaim.claimedAt'",
		);
		expect(
			statement.params.some(
				(value) => typeof value === "string" && value.startsWith("$."),
			),
		).toBe(false);
	} finally {
		sqlite.close();
	}
});
