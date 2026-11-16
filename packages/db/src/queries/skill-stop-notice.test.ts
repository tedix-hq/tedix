import { decisionFeedItems } from "@tedix/api-contract/utils/activity-feed";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import {
	SKILL_STOPPED_SCHEMA,
	plainSkillStopReason,
	raiseSkillStoppedNotice,
} from "./skill-stop-notice";
import { recordSkillRunOutcome } from "./skill-usage";
import { listWorkInteractionInbox } from "./work-items/interactions";

const T0 = "2026-11-07T08:00:00.000Z";
const SKILL = "3f2e8e1a-a21d-44b7-ba8a-13d089160185";

function seed(options: { tediOwner?: string | null } = {}) {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	sqlite.exec(`
		INSERT INTO organizations(id,name,slug) VALUES('org','Willowbrook','willowbrook');
		INSERT INTO organizations(id,name,slug) VALUES('other','Other','other');
		INSERT INTO users(id,email) VALUES('u-owner','owner@example.com');
		INSERT INTO users(id,email) VALUES('u-pat','pat@example.com');
		INSERT INTO organization_members(id,organization_id,descope_user_id,user_id,email,role,status) VALUES('m1','org','d-owner','u-owner','owner@example.com','owner','active');
		INSERT INTO organization_members(id,organization_id,descope_user_id,user_id,email,role,status) VALUES('m2','org','d-pat','u-pat','pat@example.com','member','active');
		INSERT INTO projects(id,org_id,key,name,created_at) VALUES('p-old','org','OLD','Oldest','2026-01-01T00:00:00.000Z');
		INSERT INTO projects(id,org_id,key,name,lead_tedi_id,created_at) VALUES('p-research','org','RES','Research','tedi','2026-06-01T00:00:00.000Z');
		INSERT INTO projects(id,org_id,key,name,created_at) VALUES('p-other','other','OTH','Other','2026-01-01T00:00:00.000Z');
	`);
	sqlite
		.prepare(
			"INSERT INTO tedis(id,organization_id,name,slug,status,owner_user_id) VALUES('tedi','org','Researcher','researcher','active',?)",
		)
		.run(options.tediOwner === undefined ? "d-pat" : options.tediOwner);
	sqlite
		.prepare(
			"INSERT INTO skill_entries(id,organization_id,tedi_id,title,slug,content,lifecycle_state) VALUES(?,'org','tedi','Daily research','daily-research','# Daily research','active')",
		)
		.run(SKILL);
	sqlite
		.prepare(
			"INSERT INTO skill_schedules(id,organization_id,skill_id,tedi_id,cron,params,enabled,next_fire_at,last_fire_at) VALUES('timer','org',?,'tedi','0 8 * * *','{}',1,'2026-11-08T08:00:00.000Z',?)",
		)
		.run(SKILL, T0);
	const failRun = (id: string, error: string, workItemId?: string) =>
		sqlite
			.prepare(
				"INSERT INTO skill_runs(id,organization_id,skill_id,tedi_id,workflow_instance_id,runtime_environment,status,error,created_by,work_item_id,started_at,completed_at) VALUES(?,'org',?,'tedi',?,'production','failed',?,'schedule',?,?,?)",
			)
			.run(id, SKILL, `wf-${id}`, error, workItemId ?? null, T0, T0);
	return {
		sqlite,
		db: createDbClient(createD1Facade(sqlite)),
		failRun,
		notices: () =>
			sqlite
				.prepare(
					"SELECT id,target_id,project_id,work_item_id,subject,prompt,status,metadata FROM work_interactions WHERE json_extract(metadata,'$.schema')=?",
				)
				.all(SKILL_STOPPED_SCHEMA) as Array<Record<string, string | null>>,
		lifecycle: () =>
			(
				sqlite
					.prepare("SELECT lifecycle_state FROM skill_entries WHERE id=?")
					.get(SKILL) as { lifecycle_state: string }
			).lifecycle_state,
	};
}

describe("skill stopped notice", () => {
	it("tells the tedi's owner in Activity when failed runs turn a scheduled skill off", async () => {
		const { db, failRun, notices, lifecycle } = seed();
		for (const id of ["run-1", "run-2"]) {
			failRun(id, "Error: The news source returned 401. Sign in again.");
			await recordSkillRunOutcome(db, id);
		}
		expect(lifecycle()).toBe("active");
		expect(notices()).toHaveLength(0);

		failRun(
			"run-3",
			"Error: The news source returned 401. Sign in again.\n    at fetchNews (workflow.ts:12)",
		);
		await recordSkillRunOutcome(db, "run-3");
		expect(lifecycle()).toBe("draft");
		const [notice] = notices();
		expect(notices()).toHaveLength(1);
		expect(notice).toMatchObject({
			target_id: "u-pat",
			// No Work Item on the run: the project this tedi leads carries it.
			project_id: "p-research",
			work_item_id: null,
			status: "open",
			subject:
				"“Daily research” turned itself off after 3 failed runs in a row",
		});
		expect(notice!.prompt).toContain(
			"- Last error: The news source returned 401. Sign in again.",
		);
		expect(notice!.prompt).not.toContain("workflow.ts");
		expect(notice!.prompt).toContain(`[open the skill](/skills/${SKILL})`);
		expect(JSON.parse(notice!.metadata!)).toMatchObject({
			skillId: SKILL,
			stopCause: "failed_runs",
			failedRuns: 3,
			runId: "run-3",
		});

		// The owner's inbox is what Activity and Decisions read.
		const inbox = await listWorkInteractionInbox(db, {
			orgId: "org",
			targetType: "user",
			targetId: "u-pat",
			states: ["open"],
			observedAt: T0,
		});
		expect(inbox.data).toHaveLength(1);
		const row = inbox.data[0]!;
		// The API serves the row's created time as `requestedAt`.
		const [entry] = decisionFeedItems(
			[
				{
					...row,
					request: { ...row.request, requestedAt: row.request.createdAt },
				},
			] as unknown as Parameters<typeof decisionFeedItems>[0],
			new Date(T0),
		);
		expect(entry).toMatchObject({
			kind: "decision",
			at: row.request.createdAt,
			projectId: "p-research",
			needsAction: true,
			sentence:
				"“Daily research” turned itself off after 3 failed runs in a row",
			source: `/work/interactions/${notice!.id}`,
		});
		expect(entry!.explanation).toContain("What to do next");

		// More failures, and the scheduler pausing the timer at its next fire,
		// are the same stop: the owner is not told again.
		failRun("run-4", "Error: still 401");
		await recordSkillRunOutcome(db, "run-4");
		expect(
			await raiseSkillStoppedNotice(db, {
				organizationId: "org",
				skillId: SKILL,
				cause: { kind: "inactive" },
				now: "2026-11-08T08:00:00.000Z",
			}),
		).toEqual({ raised: false, reason: "already_told" });
		expect(notices()).toHaveLength(1);
	});

	it("tells the organization owner for a shared tedi and files it on the run's Work Item", async () => {
		const { sqlite, db, failRun, notices } = seed({ tediOwner: null });
		sqlite
			.prepare(
				"INSERT INTO work_items(id,org_id,title,disposition,project_id,created_at,admission_spec_revision) VALUES('work','org','Morning brief','accepted','p-old',?,'revision-1')",
			)
			.run(T0);
		for (const id of ["run-1", "run-2", "run-3"]) {
			failRun(id, "The sheet could not be opened", "work");
			await recordSkillRunOutcome(db, id);
		}
		expect(notices()).toHaveLength(1);
		expect(notices()[0]).toMatchObject({
			target_id: "u-owner",
			work_item_id: "work",
			project_id: null,
		});
	});

	it("does not tell anyone when the schedule was already turned off by hand", async () => {
		const { sqlite, db, failRun, notices, lifecycle } = seed();
		sqlite.exec("UPDATE skill_schedules SET enabled=0");
		for (const id of ["run-1", "run-2", "run-3"]) {
			failRun(id, "The sheet could not be opened");
			await recordSkillRunOutcome(db, id);
		}
		expect(lifecycle()).toBe("draft");
		expect(notices()).toHaveLength(0);
	});

	it("tells the owner once when the scheduler pauses the timer of a skill that is not turned on", async () => {
		const { sqlite, db, notices } = seed();
		sqlite.exec("UPDATE skill_entries SET lifecycle_state='draft'");
		const input = {
			organizationId: "org",
			skillId: SKILL,
			cause: { kind: "inactive" as const },
			now: "2026-11-08T08:00:00.000Z",
		};
		expect(await raiseSkillStoppedNotice(db, input)).toMatchObject({
			raised: true,
			recipientUserId: "u-pat",
		});
		expect(await raiseSkillStoppedNotice(db, input)).toEqual({
			raised: false,
			reason: "already_told",
		});
		expect(notices()).toHaveLength(1);
		expect(notices()[0]!.subject).toBe(
			"The schedule of “Daily research” was paused because the skill is not turned on",
		);
		// Another organization's skill id finds nothing here.
		expect(
			await raiseSkillStoppedNotice(db, { ...input, organizationId: "other" }),
		).toEqual({ raised: false, reason: "not_scheduled" });
	});

	it("reduces a run error to one readable line", () => {
		expect(plainSkillStopReason("TypeError: fetch failed\n    at run")).toBe(
			"fetch failed",
		);
		expect(plainSkillStopReason(null)).toBe(
			"The run did not say why it failed.",
		);
		expect(plainSkillStopReason("x".repeat(400))).toHaveLength(300);
	});
});
