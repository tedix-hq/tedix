import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import {
	findSkillsByReference,
	listInFlightSkillRuns,
	moveSkillToTedi,
} from "./skill-ownership";

const ORG = "org-1";
const SKILL = "skill-1";

describe("skill ownership transfer", () => {
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
				lifecycle_state TEXT,
				updated_at TEXT
			);
			CREATE TABLE skill_schedules (
				id TEXT PRIMARY KEY,
				organization_id TEXT NOT NULL,
				skill_id TEXT NOT NULL UNIQUE,
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
			CREATE TABLE skill_runs (
				id TEXT PRIMARY KEY,
				organization_id TEXT NOT NULL,
				skill_id TEXT NOT NULL,
				tedi_id TEXT NOT NULL,
				status TEXT NOT NULL,
				started_at TEXT
			);
			CREATE TABLE audit_events (
				id TEXT PRIMARY KEY,
				organization_id TEXT NOT NULL,
				actor_id TEXT NOT NULL,
				actor_type TEXT NOT NULL,
				action TEXT NOT NULL,
				resource_type TEXT NOT NULL,
				resource_id TEXT,
				metadata TEXT,
				ip_address TEXT,
				user_agent TEXT,
				timestamp INTEGER NOT NULL
			);
			INSERT INTO skill_entries (id, organization_id, tedi_id, title, updated_at)
			VALUES ('${SKILL}', '${ORG}', 'tedi-a', 'Account watcher', '2026-10-01T00:00:00.000Z');
			INSERT INTO skill_schedules (
				id, organization_id, skill_id, tedi_id, cron, params, enabled,
				next_fire_at, last_fire_at, last_run_id
			) VALUES (
				'schedule-1', '${ORG}', '${SKILL}', 'tedi-a', '0 7 * * *',
				'{"mode":"daily"}', 1, '2026-10-26T07:00:00.000Z',
				'2026-10-25T07:00:00.000Z', 'run-old'
			);
		`);
		db = createDbClient(createD1Facade(sqlite));
	});

	const move = (fromTediId: string | null, toTediId: string) =>
		moveSkillToTedi(db, {
			organizationId: ORG,
			skillId: SKILL,
			fromTediId,
			toTediId,
			audit: {
				actorId: "user-1",
				actorType: "user",
				action: "skill.owner_moved",
				metadata: { fromTediId, toTediId },
			},
			now: new Date("2026-10-25T21:00:00.000Z"),
		});

	const owner = () =>
		(
			sqlite
				.prepare("SELECT tedi_id FROM skill_entries WHERE id = ?")
				.get(SKILL) as { tedi_id: string | null }
		).tedi_id;

	it("moves the owner and the schedule together and keeps the schedule's timing", async () => {
		const result = await move("tedi-a", "tedi-b");

		expect(result.moved).toBe(true);
		expect(owner()).toBe("tedi-b");
		expect(result.schedule).toMatchObject({
			id: "schedule-1",
			tediId: "tedi-b",
			cron: "0 7 * * *",
			params: { mode: "daily" },
			enabled: true,
			nextFireAt: "2026-10-26T07:00:00.000Z",
			lastFireAt: "2026-10-25T07:00:00.000Z",
			lastRunId: "run-old",
		});
		const audit = sqlite.prepare("SELECT * FROM audit_events").all() as Array<
			Record<string, unknown>
		>;
		expect(audit).toHaveLength(1);
		expect(audit[0]).toMatchObject({
			id: result.auditEventId,
			organization_id: ORG,
			actor_id: "user-1",
			action: "skill.owner_moved",
			resource_type: "skill",
			resource_id: SKILL,
			timestamp: Math.floor(Date.parse("2026-10-25T21:00:00.000Z") / 1000),
		});
		expect(JSON.parse(String(audit[0]!.metadata))).toEqual({
			fromTediId: "tedi-a",
			toTediId: "tedi-b",
		});
	});

	it("writes nothing when the owner changed after the caller read it", async () => {
		const result = await move("tedi-other", "tedi-b");

		expect(result).toMatchObject({ moved: false, auditEventId: null });
		expect(owner()).toBe("tedi-a");
		expect(result.schedule?.tediId).toBe("tedi-a");
		expect(sqlite.prepare("SELECT * FROM audit_events").all()).toHaveLength(0);
	});

	it("moves back with the same call (rollback)", async () => {
		await move("tedi-a", "tedi-b");
		const back = await moveSkillToTedi(db, {
			organizationId: ORG,
			skillId: SKILL,
			fromTediId: "tedi-b",
			toTediId: "tedi-a",
			audit: {
				actorId: "user-1",
				actorType: "user",
				action: "skill.owner_moved",
				metadata: { fromTediId: "tedi-b", toTediId: "tedi-a" },
			},
			now: new Date("2026-10-25T21:05:00.000Z"),
		});

		expect(back.moved).toBe(true);
		expect(owner()).toBe("tedi-a");
		expect(back.schedule?.tediId).toBe("tedi-a");
		expect(sqlite.prepare("SELECT * FROM audit_events").all()).toHaveLength(2);
	});

	it("attaches an owner to an ownerless skill", async () => {
		sqlite.exec(`UPDATE skill_entries SET tedi_id = NULL`);
		const result = await move(null, "tedi-b");
		expect(result.moved).toBe(true);
		expect(owner()).toBe("tedi-b");
	});

	it("never touches another organization's rows", async () => {
		const result = await moveSkillToTedi(db, {
			organizationId: "org-2",
			skillId: SKILL,
			fromTediId: "tedi-a",
			toTediId: "tedi-b",
			audit: {
				actorId: "user-1",
				actorType: "user",
				action: "skill.owner_moved",
				metadata: {},
			},
		});
		expect(result).toMatchObject({ moved: false, schedule: null });
		expect(owner()).toBe("tedi-a");
	});

	it("lists only the skill's queued, running and paused runs", async () => {
		sqlite.exec(`
			INSERT INTO skill_runs (id, organization_id, skill_id, tedi_id, status, started_at) VALUES
				('r1', '${ORG}', '${SKILL}', 'tedi-a', 'running', '2026-10-25T07:00:00Z'),
				('r2', '${ORG}', '${SKILL}', 'tedi-a', 'completed', '2026-10-24T07:00:00Z'),
				('r3', '${ORG}', '${SKILL}', 'tedi-a', 'paused', '2026-10-23T07:00:00Z'),
				('r4', '${ORG}', 'skill-2', 'tedi-a', 'running', '2026-10-25T07:00:00Z'),
				('r5', 'org-2', '${SKILL}', 'tedi-a', 'queued', '2026-10-25T07:00:00Z');
		`);
		const runs = await listInFlightSkillRuns(db, {
			organizationId: ORG,
			skillId: SKILL,
		});
		expect(runs.map((run) => [run.id, run.status])).toEqual([
			["r1", "running"],
			["r3", "paused"],
		]);
	});

	it("finds a skill by id, slug or exact title before a partial title", async () => {
		sqlite.exec(`
			UPDATE skill_entries SET slug = 'account-watcher', lifecycle_state = 'active';
			INSERT INTO skill_entries (id, organization_id, tedi_id, slug, title, lifecycle_state) VALUES
				('skill-2', '${ORG}', 'tedi-a', 'account-watcher-old', 'Account watcher (old)', 'archived'),
				('skill-3', '${ORG}', 'tedi-a', 'mail-watcher', 'Mail watcher', 'active'),
				('skill-4', 'org-2', 'tedi-z', 'account-watcher', 'Account watcher', 'active');
		`);
		const find = (reference: string) =>
			findSkillsByReference(db, { organizationId: ORG, reference }).then(
				(rows) => rows.map((row) => row.id),
			);
		expect(await find("Account Watcher")).toEqual([SKILL]);
		expect(await find("account-watcher")).toEqual([SKILL]);
		expect(await find(SKILL)).toEqual([SKILL]);
		expect(await find("watcher")).toEqual([SKILL, "skill-3"]);
		expect(await find("old")).toEqual([]);
		expect(await find("  ")).toEqual([]);
	});
});
