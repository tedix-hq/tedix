import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { coreTable } from "../core-store/client";
import { skillEntries, skillRuns } from "../schema/cognitive";
import { organizations } from "../schema/organizations";
import { tedis } from "../schema/tedis";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import { createPGliteFacade } from "../test/pglite-facade";
import {
	deleteRunArtifacts,
	getRunArtifact,
	listRunArtifacts,
	listRunArtifactsPage,
	listRunWorkflowCallArtifacts,
	listRunWorkflowStepArtifacts,
	recordRunArtifact,
} from "./skill-run-artifacts";
import { sha256Hex } from "@tedix/worker-kit/crypto";

const stores = ["d1", "postgres"] as const;
const scope = { organizationId: "org" };

for (const store of stores) {
	describe(`skill run artifacts core store: ${store}`, () => {
		let db: DbClient;
		let close: () => void | Promise<void>;
		beforeAll(async () => {
			if (store === "d1") {
				const sqlite = createMigratedSqlite();
				db = createDbClient(createD1Facade(sqlite, { maxBoundParams: 100 }));
				close = () => sqlite.close();
			} else {
				const fixture = await createPGliteFacade();
				db = fixture.db;
				close = fixture.close;
				for (const migration of readMigrationFiles({
					migrationsFolder: fileURLToPath(
						new URL("../../drizzle-pg", import.meta.url),
					),
				}))
					for (const ddl of migration.sql) await fixture.engine.exec(ddl);
			}
			await db.insert(coreTable(db, organizations)).values([
				{ id: "org", name: "Org", slug: "org" },
				{ id: "other", name: "Other", slug: "other" },
			]);
			await db.insert(coreTable(db, tedis)).values({
				id: "tedi",
				organizationId: "org",
				name: "Tedi",
				slug: "tedi",
			});
			await db.insert(coreTable(db, skillEntries)).values({
				id: "skill",
				organizationId: "org",
				title: "Skill",
				content: "Procedure",
				slug: "skill",
				lifecycleState: "active",
			});
			await db.insert(coreTable(db, skillRuns)).values({
				id: "run-1",
				organizationId: "org",
				skillId: "skill",
				tediId: "tedi",
				workflowInstanceId: "run-1",
				runtimeEnvironment: "development",
				status: "running",
			});
			await db.insert(coreTable(db, skillRuns)).values({
				id: "run-2",
				organizationId: "org",
				skillId: "skill",
				tediId: "tedi",
				workflowInstanceId: "run-2",
				runtimeEnvironment: "development",
				status: "running",
			});
		}, 30_000);
		afterAll(async () => {
			await close?.();
		});

		it("upserts inline and R2-pointer artifacts and reads them back", async () => {
			const inline = await recordRunArtifact(db, scope, {
				runId: "run-1",
				path: "timeline.json",
				value: { step: 1 },
			});
			expect(inline.contentInline).toBe('{"step":1}');
			expect(inline.contentR2Key).toBeNull();
			expect(inline.sha256).toMatch(/^[0-9a-f]{64}$/);

			// Same (runId, path) upserts in place and re-addresses the content.
			const rewritten = await recordRunArtifact(db, scope, {
				runId: "run-1",
				path: "timeline.json",
				value: { step: 2 },
			});
			expect(rewritten.id).toBe(inline.id);
			expect(rewritten.contentInline).toBe('{"step":2}');
			expect(rewritten.sha256).not.toBe(inline.sha256);

			// An R2 spill is a pointer row: no inline body, caller digest kept.
			const digest = await sha256Hex("large-body");
			const spilled = await recordRunArtifact(db, scope, {
				runId: "run-1",
				path: "evidence/blob.bin",
				value: null,
				mimeType: "application/octet-stream",
				r2Key: "run-1/bodies/blob-1",
				sizeBytes: 9,
				sha256: digest,
			});
			expect(spilled.contentInline).toBeNull();
			expect(spilled.contentR2Key).toBe("run-1/bodies/blob-1");
			expect(spilled.sizeBytes).toBe(9);
			expect(spilled.sha256).toBe(digest);

			// Re-writing the pointer path replaces the key — the upsert covers
			// R2 evidence, not just inline summaries.
			const moved = await recordRunArtifact(db, scope, {
				runId: "run-1",
				path: "evidence/blob.bin",
				value: null,
				mimeType: "application/octet-stream",
				r2Key: "run-1/bodies/blob-2",
				sizeBytes: 10,
				sha256: digest,
			});
			expect(moved.id).toBe(spilled.id);
			expect(moved.contentR2Key).toBe("run-1/bodies/blob-2");
			expect(moved.sizeBytes).toBe(10);

			const read = await getRunArtifact(
				db,
				scope,
				"run-1",
				"evidence/blob.bin",
			);
			expect(read).toMatchObject({
				contentR2Key: "run-1/bodies/blob-2",
				sha256: digest,
			});
			expect(
				await getRunArtifact(db, scope, "run-1", "missing.json"),
			).toBeNull();
		});

		it("lists, pages and filters step and call artifacts", async () => {
			await recordRunArtifact(db, scope, {
				runId: "run-2",
				path: "steps/x:alpha/1/attempts/1.json",
				value: { ok: true },
			});
			await recordRunArtifact(db, scope, {
				runId: "run-2",
				path: "epochs/3/steps/x:alpha/2/calls/1.json",
				value: { tool: "read" },
			});
			await recordRunArtifact(db, scope, {
				runId: "run-2",
				path: "steps/x:beta/sleep.json",
				value: {},
			});

			const all = await listRunArtifacts(db, scope, "run-2");
			expect(all.map((row) => row.path).sort()).toEqual([
				"epochs/3/steps/x:alpha/2/calls/1.json",
				"steps/x:alpha/1/attempts/1.json",
				"steps/x:beta/sleep.json",
			]);
			expect(
				(await listRunArtifactsPage(db, scope, "run-2", { limit: 2 }))
					.map((row) => row.path)
					.sort(),
			).toHaveLength(2);

			// stepName filtering exercises the store-specific path predicate
			// (SQLite GLOB vs Postgres regex) for both step layouts.
			// Step listing excludes nested call receipts unless kind=tool_call.
			const steps = await listRunWorkflowStepArtifacts(db, scope, "run-2", {
				stepName: "alpha",
			});
			expect(steps.map((row) => row.path)).toEqual([
				"steps/x:alpha/1/attempts/1.json",
			]);
			const calls = await listRunWorkflowCallArtifacts(db, scope, "run-2", {
				stepName: "alpha",
			});
			expect(calls.map((row) => row.path)).toEqual([
				"epochs/3/steps/x:alpha/2/calls/1.json",
			]);
			const sleeps = await listRunWorkflowStepArtifacts(db, scope, "run-2", {
				kind: "sleep",
			});
			expect(sleeps.map((row) => row.path)).toEqual([
				"steps/x:beta/sleep.json",
			]);
		});

		it("deletes all artifacts for a run", async () => {
			expect(await deleteRunArtifacts(db, scope, "run-2")).toBe(3);
			expect(await listRunArtifacts(db, scope, "run-2")).toEqual([]);
		});
	});
}
