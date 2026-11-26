import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { coreTable } from "../core-store/client";
import {
	skillEntries,
	skillRuns,
	skillWorkflowSources,
} from "../schema/cognitive";
import { commitmentWakeOutbox } from "../schema/work-items";
import { createD1Facade } from "../test/d1-facade";
import { createPGliteFacade } from "../test/pglite-facade";
import { tableDdl } from "../test/schema-ddl";
import {
	createPinnedSkillRun,
	createPinnedSkillRunWithinCap,
	createSkillRun,
	getLatestReportedSkillRun,
	getPinnedSkillWorkflowSource,
	getSkillRun,
	listFailedSkillRunEvents,
	listLatestSkillRunsForSkills,
	listSkillRunSnapshotsForSkill,
	listSkillRunsAwaitingReconcile,
	listSkillRunsForOrg,
	listSkillRunsForSkill,
	listSkillRunsForTedi,
	listSkillWorkflowRetryCandidateRuns,
	retireSkillRunForRevocation,
	updateSkillRunStatus,
} from "./skill-runs";

const at = "2026-11-20T12:00:00.000Z";
const env = "development";

for (const store of ["d1", "postgres"] as const)
	describe(`skill history ${store}`, () => {
		let db: DbClient;
		let close: () => void | Promise<void>;
		beforeAll(async () => {
			const pending: (() => Promise<unknown>)[] = [];
			if (store === "d1") {
				const sqlite = new DatabaseSync(":memory:");
				sqlite.exec(`
					PRAGMA foreign_keys = ON;
					CREATE TABLE organizations(id TEXT PRIMARY KEY);
					CREATE TABLE tedis(id TEXT PRIMARY KEY);
					CREATE TABLE memory_domains(id TEXT PRIMARY KEY);
					CREATE TABLE apps(id TEXT PRIMARY KEY);
					INSERT INTO organizations VALUES ('org'),('other');
					INSERT INTO tedis VALUES ('tedi');
				`);
				for (const table of [
					skillEntries,
					skillRuns,
					skillWorkflowSources,
					commitmentWakeOutbox,
				])
					for (const ddl of tableDdl(table)) sqlite.exec(ddl);
				const migration = readFileSync(
					new URL(
						"../../drizzle/20261125162023_commitment_wake_outbox/migration.sql",
						import.meta.url,
					),
					"utf8",
				);
				for (const statement of migration.split("--> statement-breakpoint"))
					if (/CREATE TRIGGER commitment_wake_outbox_skill_/.test(statement))
						sqlite.exec(statement);
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
					for (const ddl of migration.sql)
						if (ddl.includes("CREATE FUNCTION skill_run_commitment_wake"))
							pending.push(() => fixture.engine.exec(ddl));
						else await fixture.engine.exec(ddl);
				await fixture.engine.exec(`
					INSERT INTO organizations(id,name,slug) VALUES ('org','Org','org'),('other','Other','other');
					INSERT INTO tedis(id,organization_id,name,slug) VALUES ('tedi','org','Tedi','tedi');
				`);
			}
			await db.insert(coreTable(db, skillEntries)).values([
				{
					id: "skill",
					organizationId: "org",
					title: "Skill",
					content: "Procedure",
					slug: "skill",
					tags: ["tag"],
					lifecycleState: "active",
				},
				{
					id: "quiet",
					organizationId: "org",
					title: "Quiet",
					content: "Procedure",
					slug: "quiet",
					lifecycleState: "active",
				},
				{
					id: "foreign",
					organizationId: "other",
					title: "Other",
					content: "Procedure",
					slug: "foreign",
					lifecycleState: "active",
				},
			]);
			await db.insert(coreTable(db, skillRuns)).values({
				id: "backfill",
				organizationId: "org",
				skillId: "skill",
				tediId: "tedi",
				workflowInstanceId: "backfill",
				runtimeEnvironment: env,
				status: "completed",
				startedAt: at,
				completedAt: at,
				originTediRunId: "origin",
			});
			for (const apply of pending) await apply();
		}, 30000);
		afterAll(async () => {
			await close?.();
		});

		it("pins JSON/source atomically and caps pending admissions in one batch", async () => {
			const input = {
				runId: "pinned",
				skillId: "skill",
				tediId: "tedi",
				orgId: "org",
				workflowInstanceId: "pinned",
				runtimeEnvironment: env,
				params: { nested: [1, true] },
				workflowSource: "return 1;",
				certification: true,
				skillSlug: "skill",
				skillRevision: 1,
			} as const;
			const batch = vi.spyOn(db, "batch");
			expect(
				await createPinnedSkillRunWithinCap(db, input, {
					max: 1,
					since: "2000-01-01",
				}),
			).toBe(true);
			expect(batch).toHaveBeenCalledTimes(1);
			expect(
				await createPinnedSkillRunWithinCap(
					db,
					{ ...input, runId: "refused", workflowInstanceId: "refused" },
					{ max: 1, since: "2000-01-01" },
				),
			).toBe(false);
			expect(await getPinnedSkillWorkflowSource(db, "pinned")).toBe(
				"return 1;",
			);
			expect(await getSkillRun(db, "pinned", "org", env)).toMatchObject({
				params: input.params,
				certification: true,
				workflowSource: "return 1;",
			});
			expect(await getSkillRun(db, "pinned", "other", env)).toBeUndefined();
			await expect(
				createPinnedSkillRun(db, { ...input, workflowSource: "different" }),
			).rejects.toThrow();
			expect(await getPinnedSkillWorkflowSource(db, "pinned")).toBe(
				"return 1;",
			);
			expect(
				await db.select().from(coreTable(db, skillWorkflowSources)),
			).toHaveLength(1);
			batch.mockRestore();
		});

		it("reports typed JSON summaries and applies tags, trigger, time and privacy filters", async () => {
			await updateSkillRunStatus(db, "pinned", "completed", {
				completedAt: at,
				result: {
					status: "delivered",
					workItemId: "work",
					summary: "Delivered",
					cards: 2,
				},
			});
			const options = {
				skillTag: "tag",
				trigger: "test" as const,
				startedAfter: "2000-01-01T00:00:00.000Z",
			};
			expect(
				await listSkillRunsForTedi(db, "org", "tedi", env, options),
			).toMatchObject([
				{
					id: "pinned",
					outcome: "delivered",
					trigger: "test",
					resultSummary: "Delivered",
					workItemId: "work",
				},
			]);
			expect(
				await listSkillRunsForOrg(db, "org", env, {
					...options,
					metadataOnly: true,
				}),
			).toMatchObject([{ params: null, capabilityManifest: null }]);
			expect(
				await listSkillRunsForSkill(db, "org", "skill", env, {
					skillTag: "wrong",
				}),
			).toEqual([]);
			expect(await listSkillRunsForOrg(db, "other", env)).toEqual([]);
			expect(
				await getLatestReportedSkillRun(db, {
					organizationId: "org",
					skillId: "skill",
					runtimeEnvironment: env,
					skippedResultStatuses: ["skipped"],
				}),
			).toMatchObject({ cards: 2, summary: "Delivered" });
			expect(
				(await listSkillRunSnapshotsForSkill(db, "org", "skill", env)).find(
					(row) => row.id === "pinned",
				),
			).toMatchObject({ workflowSource: "return 1;" });
		});

		it("ranks a large skill set once, breaking ties by id without cross-tenant rows", async () => {
			const runs = coreTable(db, skillRuns);
			await db.insert(runs).values([
				{
					id: "latest-a",
					organizationId: "org",
					tediId: "tedi",
					skillId: "quiet",
					workflowInstanceId: "latest-a",
					runtimeEnvironment: env,
					status: "completed",
					startedAt: at,
				},
				{
					id: "latest-b",
					organizationId: "org",
					tediId: "tedi",
					skillId: "quiet",
					workflowInstanceId: "latest-b",
					runtimeEnvironment: env,
					status: "completed",
					startedAt: at,
				},
				{
					id: "foreign-run",
					organizationId: "other",
					tediId: "tedi",
					skillId: "foreign",
					workflowInstanceId: "foreign-run",
					runtimeEnvironment: env,
					status: "completed",
					startedAt: at,
				},
			]);
			const ids = [
				...Array.from({ length: 200 }, (_, index) => `missing-${index}`),
				"quiet",
				"foreign",
			];
			expect(
				(await listLatestSkillRunsForSkills(db, "org", ids, env)).map(
					(row) => row.id,
				),
			).toEqual(["latest-b"]);
			expect(await listLatestSkillRunsForSkills(db, "org", [], env)).toEqual(
				[],
			);
		});

		it("keeps retry/reconcile and revocation fences through native builders", async () => {
			const run = await createSkillRun(db, {
				id: "retry",
				organizationId: "org",
				tediId: "tedi",
				skillId: "quiet",
				workflowInstanceId: "retry",
				runtimeEnvironment: env,
			});
			await db
				.update(coreTable(db, skillRuns))
				.set({ skillSlug: "quiet", skillRevision: 1, startedAt: at })
				.where(eq(coreTable(db, skillRuns).id, run.id));
			await updateSkillRunStatus(db, run.id, "failed", {
				result: { summary: 123, cards: 1.5 },
				error: "WORKFLOW_ADMISSION_CREATE_FAILED: unavailable",
				completedAt: at,
			});
			expect(await listSkillRunsAwaitingReconcile(db, env, 10)).toMatchObject([
				{ id: "retry" },
			]);
			expect(
				await listSkillWorkflowRetryCandidateRuns(db, "org", env),
			).toMatchObject([{ id: "retry" }]);
			expect(
				await getLatestReportedSkillRun(db, {
					organizationId: "org",
					skillId: "quiet",
					runtimeEnvironment: env,
					skippedResultStatuses: [],
				}),
			).toMatchObject({ cards: null, summary: null });
			expect(
				await listFailedSkillRunEvents(db, {
					organizationId: "org",
					after: null,
					limit: 10,
				}),
			).toMatchObject([{ id: "retry", errorClass: "admission" }]);
			expect(
				await retireSkillRunForRevocation(db, {
					runId: "retry",
					organizationId: "org",
					runtimeEnvironment: env,
					expectedExecutionEpoch: 1,
				}),
			).toBe(false);
			await updateSkillRunStatus(db, "retry", "failed", {
				error: "Execution error",
				completedAt: at,
			});
			expect(
				await retireSkillRunForRevocation(db, {
					runId: "retry",
					organizationId: "org",
					runtimeEnvironment: env,
					expectedExecutionEpoch: 0,
				}),
			).toBe(true);
			expect(await listSkillRunsAwaitingReconcile(db, env, 10)).toEqual([]);
		});

		it("records terminal wake effects once per epoch and rolls them back with the source batch", async () => {
			const runs = coreTable(db, skillRuns);
			const outbox = coreTable(db, commitmentWakeOutbox);
			expect(
				await db.select().from(outbox).where(eq(outbox.sourceId, "backfill")),
			).toMatchObject([{ nextSendAt: "2026-11-20T12:00:30.000Z" }]);
			const values = {
				id: "wake",
				organizationId: "org",
				tediId: "tedi",
				skillId: "skill",
				workflowInstanceId: "wake",
				runtimeEnvironment: env,
				status: "completed" as const,
				completedAt: at,
				originTediRunId: "origin",
			} satisfies typeof skillRuns.$inferInsert;
			await db.insert(runs).values(values);
			expect(
				await db.select().from(outbox).where(eq(outbox.sourceId, "wake")),
			).toMatchObject([
				{
					changeKey: "skill:wake:0:completed",
					nextSendAt: "2026-11-20T12:00:30.000Z",
				},
			]);
			await db
				.update(runs)
				.set({ error: "unchanged" })
				.where(eq(runs.id, "wake"));
			expect(
				await db.select().from(outbox).where(eq(outbox.sourceId, "wake")),
			).toHaveLength(1);
			await db
				.update(runs)
				.set({ executionEpoch: 1 })
				.where(eq(runs.id, "wake"));
			expect(
				await db.select().from(outbox).where(eq(outbox.sourceId, "wake")),
			).toHaveLength(2);
			await expect(
				db.batch([
					db.insert(runs).values({
						...values,
						id: "rollback",
						workflowInstanceId: "rollback",
					}),
					db.insert(runs).values(values),
				]),
			).rejects.toThrow();
			expect(
				await db.select().from(outbox).where(eq(outbox.sourceId, "rollback")),
			).toEqual([]);
			expect(
				await db.select().from(runs).where(eq(runs.id, "rollback")),
			).toEqual([]);
		});
	});
