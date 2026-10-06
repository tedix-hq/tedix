import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import { getGovernedLearningScheduleStates } from "./flywheel/cron-executions";
import {
	listSkillSchedulesPage,
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
				description TEXT
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
