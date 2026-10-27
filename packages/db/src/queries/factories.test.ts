import { DatabaseSync } from "node:sqlite";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import {
	factoryVerdict,
	listFactoryHealth,
	loadFactoryBuildState,
	resolveFactoryRunContext,
} from "./factories";

const DDL = `
CREATE TABLE tedis (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL, display_name TEXT);
CREATE TABLE skill_entries (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, tedi_id TEXT, title TEXT NOT NULL, slug TEXT, lifecycle_state TEXT, revision INTEGER NOT NULL DEFAULT 1, created_at TEXT, content TEXT NOT NULL DEFAULT '', source_skill_id TEXT, source_revision INTEGER, tags TEXT);
CREATE TABLE skill_schedules (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, skill_id TEXT NOT NULL, tedi_id TEXT NOT NULL, cron TEXT NOT NULL, enabled INTEGER NOT NULL, next_fire_at TEXT NOT NULL, last_fire_at TEXT, last_error TEXT, created_at TEXT);
CREATE TABLE skill_runs (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, skill_id TEXT NOT NULL, tedi_id TEXT NOT NULL, status TEXT NOT NULL, params TEXT, error TEXT, started_at TEXT, completed_at TEXT, created_by TEXT);
CREATE TABLE projects (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, description TEXT, status TEXT NOT NULL DEFAULT 'active', lead_tedi_id TEXT, owner_user_id TEXT, objective_id TEXT, target_date TEXT, metadata TEXT, created_at TEXT NOT NULL, updated_at TEXT, archived_at TEXT);
CREATE TABLE work_items (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, project_id TEXT, source_intent_id TEXT, created_at TEXT NOT NULL);
CREATE TABLE work_item_comments (id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL, org_id TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE os_output_revisions (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, skill_run_id TEXT, created_at TEXT NOT NULL);
`;

const ORG = "org-1";
const NOW = new Date("2026-10-15T12:00:00.000Z");

function binding(slug: string, skillId: string, health: string) {
	return JSON.stringify({
		factory: {
			slug,
			name: slug,
			skillId,
			objectiveId: `obj-${slug}`,
			healthWorkItemId: health,
			workspaceId: null,
			template: "report",
			cadence: "daily",
			maxProposals: 3,
		},
	});
}

function seed() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(DDL);
	sqlite.exec(`
		INSERT INTO tedis VALUES ('tedi-nova', '${ORG}', 'nova', 'Nova');
		INSERT INTO skill_entries (id, organization_id, tedi_id, title, slug, lifecycle_state, revision, created_at) VALUES
			('sk-docs', '${ORG}', 'tedi-nova', 'Docs factory', 'docs', 'active', 2, '2026-10-01'),
			('sk-radar', '${ORG}', 'tedi-nova', 'Radar factory', 'radar', 'active', 1, '2026-10-01'),
			('sk-qa', '${ORG}', 'tedi-nova', 'QA factory', 'qa', 'active', 1, '2026-10-01'),
			('sk-new', '${ORG}', 'tedi-nova', 'New factory', 'new', 'draft', 1, '2026-10-15'),
			('sk-plain', '${ORG}', 'tedi-nova', 'Unscheduled skill', 'plain', 'active', 1, '2026-10-01');
		INSERT INTO skill_schedules VALUES
			('s-docs', '${ORG}', 'sk-docs', 'tedi-nova', '17 6 * * *', 1, '2026-10-16T06:17:00.000Z', '2026-10-15T06:17:00.000Z', NULL, '2026-10-01'),
			('s-radar', '${ORG}', 'sk-radar', 'tedi-nova', '43 5 * * *', 1, '2026-10-16T05:43:00.000Z', '2026-10-15T05:43:00.000Z', NULL, '2026-10-01'),
			('s-qa', '${ORG}', 'sk-qa', 'tedi-nova', '11 4 * * *', 1, '2026-10-16T04:11:00.000Z', '2026-10-15T04:11:00.000Z', NULL, '2026-10-01');
		INSERT INTO projects (id, org_id, key, name, objective_id, metadata, created_at) VALUES
			('p-docs', '${ORG}', 'DOCS', 'Docs', 'obj-docs', '${binding("docs", "sk-docs", "wi-docs-health")}', '2026-10-01'),
			('p-radar', '${ORG}', 'RADAR', 'Radar', 'obj-radar', '${binding("radar", "sk-radar", "wi-radar-health")}', '2026-10-01'),
			('p-new', '${ORG}', 'NEW', 'New', 'obj-new', '${binding("new", "sk-new", "wi-new-health")}', '2026-10-15'),
			('p-other', '${ORG}', 'OTHER', 'Other', NULL, '{}', '2026-10-01');
		INSERT INTO skill_runs VALUES
			('r-docs-1', '${ORG}', 'sk-docs', 'tedi-nova', 'completed', '{}', NULL, '2026-10-15 06:17:05', '2026-10-15 06:25:00', 'schedule'),
			('r-docs-0', '${ORG}', 'sk-docs', 'tedi-nova', 'completed', '{}', NULL, '2026-10-14 06:17:05', '2026-10-14 06:25:00', 'schedule'),
			('r-docs-probe', '${ORG}', 'sk-docs', 'tedi-nova', 'completed', '{"probe":true}', NULL, '2026-10-01 09:00:00', '2026-10-01 09:01:00', 'user-1'),
			('r-radar-1', '${ORG}', 'sk-radar', 'tedi-nova', 'completed', '{}', NULL, '2026-10-15 05:43:05', '2026-10-15 05:50:00', 'schedule'),
			('r-qa-1', '${ORG}', 'sk-qa', 'tedi-nova', 'failed', '{}', 'tool error: MCP_TARGET_UNRESOLVED', '2026-10-15 04:11:05', '2026-10-15 04:12:00', 'schedule'),
			('r-qa-0', '${ORG}', 'sk-qa', 'tedi-nova', 'completed', '{}', NULL, '2026-10-14 04:11:05', '2026-10-14 04:12:00', 'schedule');
		INSERT INTO work_items VALUES
			('wi-docs-health', '${ORG}', 'p-docs', 'factory:docs:health', '2026-10-01T00:00:00.000Z'),
			('wi-radar-health', '${ORG}', 'p-radar', 'factory:radar:health', '2026-10-01T00:00:00.000Z'),
			('wi-docs-a', '${ORG}', 'p-docs', NULL, '2026-10-15T06:20:00.000Z'),
			('wi-docs-b', '${ORG}', 'p-docs', NULL, '2026-10-15T06:21:00.000Z'),
			('wi-docs-late', '${ORG}', 'p-docs', NULL, '2026-10-15T09:00:00.000Z'),
			('wi-other', '${ORG}', 'p-other', NULL, '2026-10-15T05:45:00.000Z');
		INSERT INTO work_item_comments VALUES
			('c-docs-score', 'wi-docs-health', '${ORG}', '2026-10-15T06:24:00.000Z'),
			('c-radar-score', 'wi-radar-health', '${ORG}', '2026-10-15T05:49:00.000Z'),
			('c-other', 'wi-other', '${ORG}', '2026-10-15T05:46:00.000Z');
		INSERT INTO os_output_revisions VALUES ('rev-1', '${ORG}', 'r-docs-0', '2026-10-14 06:20:00');
	`);
	sqlite.exec("ALTER TABLE skill_runs ADD COLUMN result TEXT");
	return createDbClient(createD1Facade(sqlite));
}

describe("listFactoryHealth", () => {
	it.each([
		{
			backgroundOutcome: {
				classification: "no_change",
				summary: "No assigned Work; no inference performed.",
			},
		},
		{
			noResultReason: "Waiting for the owner's CMS consent.",
			summary: "Completed",
		},
		{ report: "INTAKE: no_updates; reviewed the current dependency pins." },
		{
			summary: { delivered: 7 },
			report: "Factory health: seven factories delivered.",
		},
	])(
		"shows the run's decision or blocker without inventing delivery: %j",
		async (result) => {
			const db = seed();
			await db.run(
				sql`UPDATE skill_runs SET result = ${JSON.stringify(result)} WHERE id = 'r-radar-1'`,
			);
			const radar = (
				await listFactoryHealth(db, { orgId: ORG, now: NOW, runLimit: 2 })
			).find((entry) => entry.slug === "radar")!;
			const expected =
				"noResultReason" in result
					? result.noResultReason
					: "report" in result
						? result.report
						: result.backgroundOutcome.summary;
			expect(radar.reason).toContain(expected);
			expect(radar.reason).not.toContain("created no Work");
			expect(radar.verdict).toBe("idle");
			expect(radar.runs[0]!.delivered).toBe(0);
		},
	);

	it("gives one verdict per factory from its runs and what they delivered", async () => {
		const db = seed();
		const health = await listFactoryHealth(db, {
			orgId: ORG,
			now: NOW,
			runLimit: 5,
		});
		const bySlug = new Map(health.map((entry) => [entry.slug, entry]));

		expect(health.map((entry) => entry.slug).sort()).toEqual([
			"docs",
			"new",
			"qa",
			"radar",
		]);

		const docs = bySlug.get("docs")!;
		expect(docs).toMatchObject({
			verdict: "healthy",
			ranToday: true,
			projectId: "p-docs",
			healthWorkItemId: "wi-docs-health",
			ownerTediName: "Nova",
			nextFireAt: "2026-10-16T06:17:00.000Z",
			lastProofRun: { runId: "r-docs-probe", status: "completed" },
		});
		expect(docs.runs.map((run) => run.runId)).toEqual([
			"r-docs-1",
			"r-docs-0",
			"r-docs-probe",
		]);
		// Items created after the run finished are not its output.
		expect(docs.runs[0]!.outputs).toEqual({
			workItemsCreated: 2,
			comments: 0,
			scorecards: 1,
			outputRevisions: 0,
		});
		expect(docs.runs[1]!.outputs.outputRevisions).toBe(1);

		// A scorecard alone is not delivery.
		expect(bySlug.get("radar")).toMatchObject({
			verdict: "idle",
			runs: [{ runId: "r-radar-1", delivered: 0, outputs: { scorecards: 1 } }],
		});

		expect(bySlug.get("qa")).toMatchObject({
			verdict: "failing",
			projectId: null,
		});
		expect(bySlug.get("qa")!.reason).toContain("MCP_TARGET_UNRESOLVED");

		expect(bySlug.get("new")).toMatchObject({
			verdict: "not_firing",
			lifecycleState: "draft",
			cron: null,
			ranToday: false,
		});
	});
});

it("includes recent failed manual proof runs without crediting schedule health", async () => {
	const db = seed();
	await db.run(sql`INSERT INTO skill_runs (id, organization_id, skill_id, tedi_id, status, params, error, started_at, completed_at, created_by) VALUES
		('proof-failure', ${ORG}, 'sk-docs', 'tedi-nova', 'failed', '{"probe":true}', 'proof failed', '2026-10-15 10:00:00', '2026-10-15 10:01:00', 'user-1'),
		('foreign-proof', 'other-org', 'sk-docs', 'tedi-nova', 'failed', '{"probe":true}', 'private', '2026-10-15 11:00:00', '2026-10-15 11:01:00', 'user-2')`);
	const docs = (
		await listFactoryHealth(db, { orgId: ORG, now: NOW, runLimit: 2 })
	).find((entry) => entry.slug === "docs")!;
	expect(docs.runs).toHaveLength(2);
	expect(docs.runs[0]).toMatchObject({
		runId: "proof-failure",
		trigger: "manual",
		status: "failed",
		error: "proof failed",
	});
	expect(docs.runs[1]!.runId).toBe("r-docs-1");
	expect(docs.lastProofRun?.runId).toBe("proof-failure");
	expect(docs.verdict).toBe("healthy");
	expect(docs.lastFiredAt).toBe("2026-10-15 06:17:05");
});

it("shows historical manual failures even when no runs fall in the health window", async () => {
	const db = seed();
	await db.run(sql`DELETE FROM skill_runs WHERE skill_id = 'sk-qa'`);
	await db.run(
		sql`INSERT INTO skill_runs (id, organization_id, skill_id, tedi_id, status, params, error, started_at, completed_at, created_by) VALUES ('old-manual', ${ORG}, 'sk-qa', 'tedi-nova', 'failed', '{}', 'manual failure', '2026-07-17 10:00:00', '2026-07-17 10:01:00', 'user-1')`,
	);
	const qa = (
		await listFactoryHealth(db, { orgId: ORG, now: NOW, runLimit: 2 })
	).find((entry) => entry.slug === "qa")!;
	expect(qa.runs).toMatchObject([
		{
			runId: "old-manual",
			status: "failed",
			trigger: "manual",
			error: "manual failure",
		},
	]);
	expect(qa.ranToday).toBe(false);
	expect(qa.verdict).toBe("not_firing");
});

describe("factoryVerdict", () => {
	const schedule = {
		enabled: true,
		cron: "17 6 * * *",
		nextFireAt: "2026-10-16T06:17:00.000Z",
		lastError: null,
		createdAt: "2026-10-01T00:00:00.000Z",
	};
	const run = (status: string, delivered: number, firedAt: string) => ({
		runId: `r-${status}`,
		status,
		firedAt,
		error: null,
		delivered,
	});

	it("reports an overdue schedule as not firing", () => {
		expect(
			factoryVerdict({
				now: NOW,
				lifecycleState: "active",
				schedule: { ...schedule, nextFireAt: "2026-10-15T09:00:00.000Z" },
				runs: [run("completed", 3, "2026-10-14T09:00:00.000Z")],
			}).verdict,
		).toBe("not_firing");
	});

	it("reports a silent day as not firing", () => {
		expect(
			factoryVerdict({
				now: NOW,
				lifecycleState: "active",
				schedule,
				runs: [run("completed", 3, "2026-10-13T06:17:00.000Z")],
			}).verdict,
		).toBe("not_firing");
	});

	it("judges a weekly factory between runs on its last run", () => {
		const weekly = {
			...schedule,
			cron: "0 8 * * 1",
			nextFireAt: "2026-10-19T08:00:00.000Z",
		};
		expect(
			factoryVerdict({
				now: NOW,
				lifecycleState: "active",
				schedule: weekly,
				runs: [run("completed", 2, "2026-10-12T08:00:00.000Z")],
			}).verdict,
		).toBe("healthy");
		expect(
			factoryVerdict({
				now: NOW,
				lifecycleState: "active",
				schedule: weekly,
				runs: [run("completed", 2, "2026-10-05T08:00:00.000Z")],
			}),
		).toEqual({
			verdict: "not_firing",
			reason:
				"The last run fired at 2026-10-05T08:00:00.000Z; the next was due at 2026-10-12T08:00:00.000Z and did not fire.",
		});
	});

	it("reports a turned-off schedule as paused, not broken", () => {
		expect(
			factoryVerdict({
				now: NOW,
				lifecycleState: "active",
				schedule: { ...schedule, enabled: false },
				runs: [run("completed", 3, "2026-10-01T06:17:00.000Z")],
			}).verdict,
		).toBe("paused");
	});

	it("waits for a new factory's first run", () => {
		expect(
			factoryVerdict({
				now: NOW,
				lifecycleState: "active",
				schedule: { ...schedule, createdAt: "2026-10-15T10:00:00.000Z" },
				runs: [],
			}).verdict,
		).toBe("pending");
	});

	it("judges the newest finished run", () => {
		const today = "2026-10-15T06:17:00.000Z";
		expect(
			factoryVerdict({
				now: NOW,
				lifecycleState: "active",
				schedule,
				runs: [run("running", 0, today), run("completed", 0, today)],
			}).verdict,
		).toBe("idle");
		expect(
			factoryVerdict({
				now: NOW,
				lifecycleState: "active",
				schedule,
				runs: [run("canceled", 0, today), run("completed", 4, today)],
			}).verdict,
		).toBe("failing");
	});
});

describe("loadFactoryBuildState", () => {
	it("finds the bound project, lane skill, schedule and health item by slug", async () => {
		const db = seed();
		const state = await loadFactoryBuildState(db, {
			orgId: ORG,
			slug: "docs",
			projectKey: "DOCS-ELSEWHERE",
		});
		expect(state).toMatchObject({
			skill: { id: "sk-docs", lifecycleState: "active" },
			schedule: { cron: "17 6 * * *", enabled: true },
			project: { id: "p-docs" },
			healthWorkItemId: "wi-docs-health",
		});

		const fresh = await loadFactoryBuildState(db, {
			orgId: ORG,
			slug: "missing",
			projectKey: "OTHER",
		});
		expect(fresh).toEqual({
			skill: null,
			schedule: null,
			project: expect.objectContaining({ id: "p-other" }),
			healthWorkItemId: null,
		});
	});
});

describe("factory run context", () => {
	it("resolves tenant-owned binding and current pin without a skill edit", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(DDL);
		sqlite.exec(`CREATE TABLE os_workspaces (id TEXT PRIMARY KEY, organization_id TEXT, status TEXT, source_blueprint_revision_id TEXT);
   INSERT INTO skill_entries (id, organization_id, tedi_id, title) VALUES ('skill', 'org', 'owner', 'Lane');
   INSERT INTO projects (id, org_id, key, name, status, objective_id, metadata, created_at) VALUES
   ('project', 'org', 'P', 'P', 'active', 'objective', '{"factory":{"slug":"lane","skillId":"skill","workspaceId":"workspace","resourceIds":{"docsSite":"site","dailyCheck":"check"}}}', 'now');
   INSERT INTO os_workspaces VALUES ('workspace', 'org', 'active', 'revision-1');`);
		const db = createDbClient(createD1Facade(sqlite));
		const params = { orgId: "org", skillId: "skill" };
		expect(await resolveFactoryRunContext(db, params)).toMatchObject({
			workspaceId: "workspace",
			projectId: "project",
			objectiveId: "objective",
			ownerTediId: "owner",
			blueprintRevisionId: "revision-1",
			resourceIds: { docsSite: "site", dailyCheck: "check" },
		});
		const before = sqlite
			.prepare("SELECT metadata FROM projects WHERE id = 'project'")
			.get() as { metadata: string };
		const malformed = JSON.parse(before.metadata);
		malformed.factory.resourceIds = { docsSite: 12 };
		sqlite
			.prepare("UPDATE projects SET metadata = ? WHERE id = 'project'")
			.run(JSON.stringify(malformed));
		await expect(resolveFactoryRunContext(db, params)).rejects.toThrow(
			"FACTORY_RESOURCE_IDS_INVALID",
		);
		sqlite
			.prepare("UPDATE projects SET metadata = ? WHERE id = 'project'")
			.run(before.metadata);
		sqlite.exec(
			"UPDATE os_workspaces SET source_blueprint_revision_id = 'revision-2'",
		);
		expect(await resolveFactoryRunContext(db, params)).toMatchObject({
			blueprintRevisionId: "revision-2",
		});
		expect(
			await resolveFactoryRunContext(db, { ...params, orgId: "other" }),
		).toBeNull();
		sqlite.exec("UPDATE os_workspaces SET organization_id = 'other'");
		await expect(resolveFactoryRunContext(db, params)).rejects.toThrow(
			"FACTORY_WORKSPACE_UNAVAILABLE",
		);
		sqlite.exec(
			"UPDATE os_workspaces SET organization_id = 'org', status = 'archived'",
		);
		await expect(resolveFactoryRunContext(db, params)).rejects.toThrow(
			"FACTORY_WORKSPACE_UNAVAILABLE",
		);
		sqlite.exec(
			`INSERT INTO projects (id, org_id, key, name, metadata, created_at) SELECT 'second', org_id, 'Q', name, metadata, created_at FROM projects`,
		);
		await expect(resolveFactoryRunContext(db, params)).rejects.toThrow(
			"FACTORY_BINDING_AMBIGUOUS",
		);
		sqlite.close();
	});
});

describe("factory improvement context", () => {
	it("inherits only current same-owner, same-organization proposal lineage", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(DDL);
		sqlite.exec(`INSERT INTO skill_entries (id, organization_id, tedi_id, title, lifecycle_state, source_skill_id, source_revision, tags) VALUES
   ('canonical', 'org', 'owner', 'Canonical', 'active', NULL, NULL, '[]'),
   ('proposal', 'org', 'owner', 'Candidate', 'draft', 'canonical', 1, '["workflow-improvement"]'),
   ('ordinary-copy', 'org', 'owner', 'Copy', 'draft', 'canonical', 1, '[]'),
   ('foreign', 'other', 'owner', 'Foreign', 'draft', 'canonical', 1, '["workflow-improvement"]'),
   ('other-owner', 'org', 'other-owner', 'Other owner', 'draft', 'canonical', 1, '["workflow-improvement"]'),
   ('stale', 'org', 'owner', 'Stale', 'draft', 'canonical', 2, '["workflow-improvement"]');
   INSERT INTO projects (id, org_id, key, name, metadata, created_at) VALUES
   ('project', 'org', 'P', 'Project', '{"factory":{"slug":"factory","skillId":"canonical"}}', 'now'),
   ('foreign-project', 'other', 'F', 'Foreign', '{"factory":{"slug":"factory","skillId":"canonical"}}', 'now');`);
		const db = createDbClient(createD1Facade(sqlite));
		const canonical = await resolveFactoryRunContext(db, {
			orgId: "org",
			skillId: "canonical",
		});
		expect(
			await resolveFactoryRunContext(db, { orgId: "org", skillId: "proposal" }),
		).toEqual(canonical);
		for (const skillId of ["ordinary-copy", "foreign", "other-owner", "stale"])
			expect(
				await resolveFactoryRunContext(db, { orgId: "org", skillId }),
			).toBeNull();
		expect(
			await resolveFactoryRunContext(db, {
				orgId: "other",
				skillId: "foreign",
			}),
		).toBeNull();
		sqlite.exec("UPDATE skill_entries SET revision = 2 WHERE id = 'canonical'");
		expect(
			await resolveFactoryRunContext(db, { orgId: "org", skillId: "proposal" }),
		).toBeNull();
		sqlite.close();
	});
});
