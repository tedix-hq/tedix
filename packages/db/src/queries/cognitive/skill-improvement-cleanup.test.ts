import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import {
	skillEntries,
	skillRuns,
	skillSchedules,
	skillUsageEvents,
	skillWorkflowSources,
} from "../../schema/cognitive";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import {
	adoptSkillImprovementCopy,
	removeSkillImprovementCopy,
	sweepAbandonedSkillImprovements,
} from "./skill-improvement-cleanup";

describe("workflow improvement cleanup", () => {
	let sqlite: DatabaseSync;
	let db: ReturnType<typeof createDbClient>;
	const now = new Date("2026-11-05T03:00:00Z");
	beforeEach(async () => {
		sqlite = new DatabaseSync(":memory:");
		sqlite.exec(`
			CREATE TABLE organizations (id TEXT PRIMARY KEY);
			CREATE TABLE tedis (id TEXT PRIMARY KEY);
			CREATE TABLE memory_domains (id TEXT PRIMARY KEY);
			CREATE TABLE apps (id TEXT PRIMARY KEY);
			INSERT INTO organizations VALUES ('org-1'), ('org-2');
			INSERT INTO tedis VALUES ('tedi-1');
		`);
		sqlite.exec(
			schemaDdl(
				skillEntries,
				skillRuns,
				skillSchedules,
				skillUsageEvents,
				skillWorkflowSources,
			),
		);
		sqlite.exec("PRAGMA foreign_keys = ON");
		db = createDbClient(createD1Facade(sqlite, { maxBoundParams: 100 }));
		await db.insert(skillEntries).values({
			id: "main",
			organizationId: "org-1",
			title: "Main",
			content: "Original",
			revision: 2,
			revisionReasoning: "Original history",
		});
	});
	afterEach(() => sqlite.close());
	async function copy(
		id = "copy",
		overrides: Partial<typeof skillEntries.$inferInsert> = {},
	) {
		await db.insert(skillEntries).values({
			id,
			organizationId: "org-1",
			tediId: "tedi-1",
			title: id,
			content: "Candidate",
			sourceSkillId: "main",
			sourceRevision: 2,
			tags: ["workflow-improvement"],
			createdAt: "2026-11-04 03:00:00",
			updatedAt: "2026-11-04 03:00:00",
			...overrides,
		});
	}
	async function run(status: typeof skillRuns.$inferInsert.status) {
		await db.insert(skillRuns).values({
			id: "run",
			organizationId: "org-1",
			skillId: "copy",
			tediId: "tedi-1",
			workflowInstanceId: "instance",
			runtimeEnvironment: "production",
			status,
		});
	}
	const reject = () =>
		removeSkillImprovementCopy(db, {
			organizationId: "org-1",
			id: "copy",
			reason: "Rejected: simpler workflow preferred",
			now,
		});
	const history = () =>
		sqlite
			.prepare("SELECT revision_reasoning FROM skill_entries WHERE id = 'main'")
			.get();
	it("rejects once, cascades runs, usage, sources and timers, and retains history", async () => {
		await copy();
		await run("completed");
		await db.insert(skillUsageEvents).values({
			id: "usage",
			organizationId: "org-1",
			skillId: "copy",
			runId: "run",
			source: "workflow_run",
			outcome: "success",
		});
		await db
			.insert(skillWorkflowSources)
			.values({ skillId: "copy", sha256: "digest", workflowSource: "source" });
		await db.insert(skillSchedules).values({
			id: "timer",
			organizationId: "org-1",
			skillId: "copy",
			tediId: "tedi-1",
			cron: "0 0 * * *",
			params: {},
			nextFireAt: now.toISOString(),
		});
		expect(await reject()).toBe(true);
		for (const table of [
			"skill_runs",
			"skill_usage_events",
			"skill_workflow_sources",
			"skill_schedules",
		])
			expect(
				sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get(),
			).toEqual({ n: 0 });
		expect(history()).toEqual({
			revision_reasoning:
				"Original history\nRemoved 1 workflow improvement copy (copy): Rejected: simpler workflow preferred",
		});
		expect(await reject()).toBe(false);
		expect(await db.select().from(skillEntries)).toHaveLength(1);
	});
	it("sweeps superseded copies and seven-day drafts, keeping current and recently changed proposals", async () => {
		await copy("superseded", { sourceRevision: 1, lifecycleState: "stale" });
		await copy("expired", {
			createdAt: "2026-10-29 03:00:00",
			updatedAt: "2026-10-29 03:00:00",
		});
		await copy("fresh");
		await copy("reviewed", {
			createdAt: "2026-10-01",
			updatedAt: "2026-11-04",
		});
		await copy("ordinary", { tags: [] });
		await copy("foreign", { organizationId: "org-2", sourceRevision: 1 });
		expect(await sweepAbandonedSkillImprovements(db, { now })).toEqual({
			removedIds: ["expired", "superseded"],
		});
		expect(history()).toEqual({
			revision_reasoning: expect.stringContaining("(expired)"),
		});
		expect(history()).toEqual({
			revision_reasoning: expect.stringContaining("(superseded)"),
		});
		expect(await sweepAbandonedSkillImprovements(db, { now })).toEqual({
			removedIds: [],
		});
	});
	it.each(["queued", "running", "paused"] as const)(
		"keeps %s runs during rejection and sweeping",
		async (status) => {
			await copy("copy", { sourceRevision: 1 });
			await run(status);
			expect(await reject()).toBe(false);
			expect(await sweepAbandonedSkillImprovements(db, { now })).toEqual({
				removedIds: [],
			});
			expect(history()).toEqual({ revision_reasoning: "Original history" });
		},
	);
	it("keeps adopted copies and their certified runs", async () => {
		await copy("copy", {
			sourceRevision: 1,
			improvementAdoption: {
				activatedIntoRevision: 2,
				certificationRunId: "run",
				adoptedAt: now.toISOString(),
				reason: "Adopted",
			},
		});
		await run("completed");
		expect(await reject()).toBe(false);
		expect(await sweepAbandonedSkillImprovements(db, { now })).toEqual({
			removedIds: [],
		});
		expect(await db.select().from(skillRuns)).toHaveLength(1);
	});
	it("keeps legacy adoption evidence recorded only on the main skill", async () => {
		await copy("copy", { sourceRevision: 1 });
		sqlite.exec(
			"UPDATE skill_entries SET revision_reasoning = 'Workflow improvement copy activated by user owner after certified run run' WHERE id = 'main'",
		);
		expect(await reject()).toBe(false);
		expect(await sweepAbandonedSkillImprovements(db, { now })).toEqual({
			removedIds: [],
		});
	});
	it("rechecks active runs after selecting abandoned copies", async () => {
		await copy("copy", { sourceRevision: 1 });
		await run("completed");
		let changed = false;
		const racingDb = createDbClient(
			createD1Facade(sqlite, {
				onPrepare(query) {
					if (!changed && query.startsWith('update "skill_entries"')) {
						changed = true;
						sqlite.exec(
							"UPDATE skill_runs SET status = 'running' WHERE id = 'run'",
						);
					}
				},
			}),
		);
		expect(await sweepAbandonedSkillImprovements(racingDb, { now })).toEqual({
			removedIds: [],
		});
		expect(changed).toBe(true);
		expect(history()).toEqual({ revision_reasoning: "Original history" });
	});

	it("rolls back history if cascade deletion fails", async () => {
		await copy();
		sqlite.exec(
			"CREATE TRIGGER fail_delete BEFORE DELETE ON skill_entries BEGIN SELECT RAISE(ABORT, 'blocked'); END",
		);
		await expect(reject()).rejects.toThrow();
		expect(history()).toEqual({ revision_reasoning: "Original history" });
	});
	it("rolls back deletion and cascades when writing history fails", async () => {
		await copy();
		await run("completed");
		sqlite.exec(
			"CREATE TRIGGER fail_history BEFORE UPDATE ON skill_entries WHEN OLD.id = 'main' BEGIN SELECT RAISE(ABORT, 'blocked'); END",
		);
		await expect(reject()).rejects.toThrow();
		expect(await db.select().from(skillEntries)).toHaveLength(2);
		expect(await db.select().from(skillRuns)).toHaveLength(1);
	});

	it("does not mistake the rejection reason for a previous adoption", async () => {
		await copy();
		expect(
			await removeSkillImprovementCopy(db, {
				organizationId: "org-1",
				id: "copy",
				reason:
					"Workflow improvement copy activated by user was only an example",
			}),
		).toBe(true);
	});

	it("adopts atomically and cannot adopt a copy removed after the initial read", async () => {
		await copy();
		const entries = await db.select().from(skillEntries);
		const baseline = entries.find((e) => e.id === "main")!;
		const proposal = entries.find((e) => e.id === "copy")!;
		const params = {
			baseline,
			proposal,
			baselineUpdates: {
				content: "Candidate",
				revision: 3,
				revisionReasoning: "Workflow improvement copy activated by user owner",
			},
			proposalUpdates: {
				lifecycleState: "archived" as const,
				revision: 2,
				improvementAdoption: {
					activatedIntoRevision: 3,
					certificationRunId: null,
					adoptedAt: now.toISOString(),
					reason: "Adopted",
				},
			},
		};
		expect(await adoptSkillImprovementCopy(db, params)).toBe(true);
		expect(await reject()).toBe(false);
		expect(await sweepAbandonedSkillImprovements(db, { now })).toEqual({
			removedIds: [],
		});
		await copy("other");
		const other = (await db.select().from(skillEntries)).find(
			(e) => e.id === "other",
		)!;
		expect(
			await removeSkillImprovementCopy(db, {
				organizationId: "org-1",
				id: "other",
				reason: "Rejected",
			}),
		).toBe(true);
		expect(
			await adoptSkillImprovementCopy(db, {
				...params,
				proposal: other,
				baseline: { ...baseline, revision: 3 },
				baselineUpdates: { ...params.baselineUpdates, revision: 4 },
			}),
		).toBe(false);
		expect(
			(await db.select().from(skillEntries)).find((e) => e.id === "main")
				?.revision,
		).toBe(3);
	});
});
