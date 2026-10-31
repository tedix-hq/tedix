import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import { getGovernedLearningScheduleStates } from "./flywheel/cron-executions";
import {
	listSkillSchedulesPage,
	listDueSkillSchedules,
	getSkillSchedule,
	pauseSkillSchedule,
	insertActivatedSkillSchedule,
	recordSkillScheduleDispatch,
	recordSkillScheduleError,
	recordSkillScheduleSuppressed,
} from "./skill-schedules";

describe("skill schedule budget state", () => {
	let sqlite: DatabaseSync;
	let db: ReturnType<typeof createDbClient>;

	beforeEach(() => {
		sqlite = new DatabaseSync(":memory:");
		sqlite.exec(`
			CREATE TABLE skill_entries (
				id TEXT PRIMARY KEY,
				organization_id TEXT NOT NULL,
				tedi_id TEXT,
				slug TEXT,
				title TEXT,
				description TEXT,
				lifecycle_state TEXT DEFAULT 'active'
			);
			CREATE TABLE skill_schedules (
				id TEXT PRIMARY KEY,
				organization_id TEXT NOT NULL,
				skill_id TEXT NOT NULL,
				tedi_id TEXT NOT NULL,
				cron TEXT NOT NULL,
				params TEXT NOT NULL,
				enabled INTEGER NOT NULL,
				next_fire_at TEXT NOT NULL,
				last_fire_at TEXT,
				last_run_id TEXT,
				last_error TEXT,
				last_budget_blocked_at TEXT,
				last_budget_blocked_reason TEXT,
				last_budget_reset_at TEXT,
				last_budget_admission_class TEXT,
				created_at TEXT,
				updated_at TEXT
			);
			INSERT INTO skill_schedules (
				id, organization_id, skill_id, tedi_id, cron, params, enabled,
				next_fire_at
			) VALUES (
				'schedule-1', 'org-1', 'skill-1', 'tedi-1', '0 * * * *', '{}', 1,
				'2026-07-25T04:00:00.000Z'
			);
			INSERT INTO skill_entries (
				id, organization_id, tedi_id, slug, title, description
			)
			VALUES (
				'skill-1', 'org-1', 'tedi-1',
				'platform-brain-reflection-dogfood', 'Brain reflection',
				'Reflects on durable memory'
			);
		`);
		db = createDbClient(createD1Facade(sqlite));
	});

	it("pauses only the owning org timer and resumes it on activation", async () => {
		sqlite.exec(
			"CREATE UNIQUE INDEX schedule_skill ON skill_schedules(skill_id)",
		);
		await pauseSkillSchedule(db, "skill-1", "other-org");
		expect((await getSkillSchedule(db, "skill-1"))?.enabled).toBe(true);
		await pauseSkillSchedule(db, "skill-1", "org-1");
		expect((await getSkillSchedule(db, "skill-1"))?.enabled).toBe(false);
		await insertActivatedSkillSchedule(db, {
			id: "skill-1",
			tags: null,
			organizationId: "org-1",
			tediId: "tedi-1",
			content:
				'---\ncapabilities:\n  schedule:\n    cron: "0 * * * *"\n    enabled: true\n---',
		});
		expect((await getSkillSchedule(db, "skill-1"))?.enabled).toBe(true);
	});

	it("excludes an archived enabled timer before applying the due limit", async () => {
		sqlite.exec(`
			UPDATE skill_entries SET lifecycle_state = 'archived';
			INSERT INTO skill_entries (id, organization_id) VALUES ('live', 'org-2');
			INSERT INTO skill_schedules (id, organization_id, skill_id, tedi_id, cron, params, enabled, next_fire_at)
			VALUES ('live-timer', 'org-2', 'live', 'tedi-2', '0 8 * * *', '{}', 1, '2026-07-25T05:00:00.000Z');
		`);
		expect(
			(await listDueSkillSchedules(db, "2026-07-26T00:00:00.000Z", 1)).map(
				(row) => row.id,
			),
		).toEqual(["live-timer"]);
	});

	it("fixes archived enabled timers across organizations and reports an idempotent count", () => {
		sqlite.exec(`
			UPDATE skill_entries SET lifecycle_state = 'archived';
			INSERT INTO skill_entries (id, organization_id, lifecycle_state) VALUES ('archived-2', 'org-2', 'archived'), ('live', 'org-2', 'active');
			INSERT INTO skill_schedules (id, organization_id, skill_id, tedi_id, cron, params, enabled, next_fire_at) VALUES
			('timer-2', 'org-2', 'archived-2', 'tedi-2', '0 8 * * *', '{}', 1, '2026-07-25T05:00:00.000Z'),
			('paused', 'org-2', 'archived-2', 'tedi-2', '0 8 * * *', '{}', 0, '2026-07-25T05:00:00.000Z'),
			('live', 'org-2', 'live', 'tedi-2', '0 8 * * *', '{}', 1, '2026-07-25T05:00:00.000Z');
		`);
		const repair = readFileSync(
			new URL(
				"../../../../scripts/skills/pause-archived-schedules.sql",
				import.meta.url,
			),
			"utf8",
		);
		const [update, report] = repair.split(";").filter((part) => part.trim());
		sqlite.exec(update!);
		expect(sqlite.prepare(report!).get()).toEqual({ paused_count: 2 });
		expect(
			sqlite
				.prepare("SELECT enabled FROM skill_schedules WHERE id = 'live'")
				.get(),
		).toEqual({ enabled: 1 });
		sqlite.exec(update!);
		expect(sqlite.prepare(report!).get()).toEqual({ paused_count: 0 });
	});

	it("does not schedule an activated improvement copy", async () => {
		const inserted = await insertActivatedSkillSchedule(db, {
			id: "proposal",
			organizationId: "org-1",
			tediId: "tedi-1",
			tags: ["workflow-improvement"],
			content:
				'---\ncapabilities:\n  schedule:\n    cron: "0 8 * * *"\n---\n# Proposal',
		});
		expect(inserted).toBe(false);
		expect(await getSkillSchedule(db, "proposal")).toBeUndefined();
	});

	it("searches canonical skill metadata and reports an accurate page total", async () => {
		sqlite.exec(`
			INSERT INTO skill_entries (
				id, organization_id, tedi_id, slug, title, description
			) VALUES (
				'skill-2', 'org-1', 'tedi-1', 'weekly-digest',
				'Weekly digest', 'Sends the customer report'
			);
			INSERT INTO skill_schedules (
				id, organization_id, skill_id, tedi_id, cron, params, enabled,
				next_fire_at
			) VALUES (
				'schedule-2', 'org-1', 'skill-2', 'tedi-1', '0 9 * * 1', '{}', 1,
				'2026-07-28T09:00:00.000Z'
			);
		`);

		const result = await listSkillSchedulesPage(db, "org-1", {
			limit: 1,
			offset: 0,
			query: "CUSTOMER",
		});

		expect(result.total).toBe(1);
		expect(result.schedules.map((schedule) => schedule.id)).toEqual([
			"schedule-2",
		]);
	});

	it("leaves out schedules whose params name an excluded id", async () => {
		sqlite.exec(`
			INSERT INTO skill_schedules (
				id, organization_id, skill_id, tedi_id, cron, params, enabled,
				next_fire_at
			) VALUES (
				'schedule-private', 'org-1', 'skill-1', 'tedi-1', '0 9 * * *',
				'{"projectIds":["project-public","project-private"]}', 1,
				'2026-07-28T09:00:00.000Z'
			);
		`);

		const result = await listSkillSchedulesPage(db, "org-1", {
			excludeParamsReferenceId: "project-private",
		});

		expect(result.schedules.map((schedule) => schedule.id)).not.toContain(
			"schedule-private",
		);
		expect(result.total).toBe(result.schedules.length);
		expect(
			(await listSkillSchedulesPage(db, "org-1", {})).schedules.map(
				(schedule) => schedule.id,
			),
		).toContain("schedule-private");
	});

	it("matches a query longer than D1's 50-byte LIKE pattern cap", async () => {
		// The LIKE this replaced turned any 48+ character search into a D1_ERROR.
		const description =
			"Sends the weekly customer report to every regional account manager";
		sqlite.exec(`
			INSERT INTO skill_entries (
				id, organization_id, tedi_id, slug, title, description
			) VALUES (
				'skill-2', 'org-1', 'tedi-1', 'weekly-digest', 'Weekly digest',
				'${description}'
			);
			INSERT INTO skill_schedules (
				id, organization_id, skill_id, tedi_id, cron, params, enabled,
				next_fire_at
			) VALUES (
				'schedule-2', 'org-1', 'skill-2', 'tedi-1', '0 9 * * 1', '{}', 1,
				'2026-07-28T09:00:00.000Z'
			);
		`);

		const result = await listSkillSchedulesPage(db, "org-1", {
			query: description.toUpperCase(),
		});

		expect(result.total).toBe(1);
		expect(result.schedules.map((schedule) => schedule.id)).toEqual([
			"schedule-2",
		]);
	});

	it("records a structured non-error block and clears it on dispatch", async () => {
		await recordSkillScheduleSuppressed(db, {
			scheduleId: "schedule-1",
			scheduledFireAt: "2026-07-25T04:00:00.000Z",
			nextFireAt: "2026-07-25T05:00:00.000Z",
			reason: "protected learning slice exhausted",
			resetAt: "2026-07-26T00:00:00.000Z",
			admissionClass: "governed_learning",
		});
		expect(
			sqlite
				.prepare(
					`SELECT last_error, last_budget_blocked_at,
						last_budget_blocked_reason, last_budget_reset_at,
						last_budget_admission_class, last_run_id
					FROM skill_schedules WHERE id = 'schedule-1'`,
				)
				.get(),
		).toEqual({
			last_error: null,
			last_budget_blocked_at: "2026-07-25T04:00:00.000Z",
			last_budget_blocked_reason: "protected learning slice exhausted",
			last_budget_reset_at: "2026-07-26T00:00:00.000Z",
			last_budget_admission_class: "governed_learning",
			last_run_id: null,
		});
		expect(
			await getGovernedLearningScheduleStates(db, {
				orgId: "org-1",
				tediId: "tedi-1",
			}),
		).toEqual([
			{
				cronName: "brain-reflection",
				enabled: 1,
				lastBudgetBlockedAt: "2026-07-25T04:00:00.000Z",
				lastBudgetBlockedReason: "protected learning slice exhausted",
				lastBudgetResetAt: "2026-07-26T00:00:00.000Z",
				lastBudgetAdmissionClass: "governed_learning",
			},
		]);

		await recordSkillScheduleDispatch(db, {
			scheduleId: "schedule-1",
			scheduledFireAt: "2026-07-25T05:00:00.000Z",
			nextFireAt: "2026-07-25T06:00:00.000Z",
			runId: "run-1",
		});
		expect(
			sqlite
				.prepare(
					`SELECT last_budget_blocked_at, last_budget_blocked_reason,
						last_budget_reset_at, last_budget_admission_class, last_run_id
					FROM skill_schedules WHERE id = 'schedule-1'`,
				)
				.get(),
		).toEqual({
			last_budget_blocked_at: null,
			last_budget_blocked_reason: null,
			last_budget_reset_at: null,
			last_budget_admission_class: null,
			last_run_id: "run-1",
		});
	});

	it("clears an old budget block when the next occurrence is a real error", async () => {
		await recordSkillScheduleSuppressed(db, {
			scheduleId: "schedule-1",
			scheduledFireAt: "2026-07-25T04:00:00.000Z",
			nextFireAt: "2026-07-25T05:00:00.000Z",
			reason: "background exhausted",
			resetAt: "2026-07-26T00:00:00.000Z",
			admissionClass: "background",
		});
		await recordSkillScheduleError(db, "schedule-1", "runtime unavailable");
		expect(
			sqlite
				.prepare(
					`SELECT last_error, last_budget_blocked_at,
						last_budget_blocked_reason, last_budget_reset_at,
						last_budget_admission_class
					FROM skill_schedules WHERE id = 'schedule-1'`,
				)
				.get(),
		).toEqual({
			last_error: "runtime unavailable",
			last_budget_blocked_at: null,
			last_budget_blocked_reason: null,
			last_budget_reset_at: null,
			last_budget_admission_class: null,
		});
	});
});
