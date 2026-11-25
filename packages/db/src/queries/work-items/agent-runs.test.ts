import { eq } from "drizzle-orm";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { organizations } from "../../schema/organizations";
import { tedis } from "../../schema/tedis";
import { workAdmissions } from "../../schema/work-factory";
import {
	workAttemptMessages,
	workAttemptSteps,
	workAttempts,
	workItems,
} from "../../schema/work-items";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import {
	AGENT_RUN_SOURCE,
	agentRunSupervisionState,
	listAgentRuns,
	listAgentRunSupervisors,
	recordAgentRunSupervisionRound,
} from "./agent-runs";

const now = "2026-10-10T12:00:00.000Z";
const later = "2026-10-10T12:30:00.000Z";
const earlier = "2026-10-10T11:00:00.000Z";
const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});

async function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		schemaDdl(
			workItems,
			workAttempts,
			workAttemptSteps,
			workAttemptMessages,
			workAdmissions,
		),
	);
	const db = createDbQueryClient(createD1Facade(sqlite));
	const run = (
		id: string,
		createdAt: string,
		extra: Partial<typeof workItems.$inferInsert> = {},
	) => ({
		id,
		orgId: "org",
		title: `Run ${id}`,
		disposition: "accepted" as const,
		executorType: "external_agent" as const,
		executorId: "codex",
		stewardType: "tedi" as const,
		stewardId: "tedi-a",
		sourceSessionKey: "agent:main:chat",
		metadata: { source: AGENT_RUN_SOURCE },
		createdAt,
		...extra,
	});
	for (const row of [
		run("waiting", "2026-10-10T10:00:00.000Z"),
		run("running", "2026-10-10T10:01:00.000Z"),
		run("failed", "2026-10-10T10:02:00.000Z"),
		run("lapsed", "2026-10-10T10:03:00.000Z"),
		run("other-tedi", "2026-10-10T10:04:00.000Z", { stewardId: "tedi-b" }),
		run("other-org", "2026-10-10T10:05:00.000Z", { orgId: "elsewhere" }),
		// Not agent runs: another source, no source conversation, a tedi
		// executor, too old.
		run("other-source", "2026-10-10T10:08:00.000Z", {
			metadata: { source: "elsewhere" },
		}),
		run("no-chat", "2026-10-10T10:06:00.000Z", { sourceSessionKey: null }),
		run("tedi-task", "2026-10-10T10:07:00.000Z", {
			executorType: "tedi",
			executorId: "tedi-a",
		}),
		run("old", "2026-08-01T00:00:00.000Z"),
	])
		await db.insert(workItems).values(row);
	const attempt = (
		id: string,
		workItemId: string,
		extra: Partial<typeof workAttempts.$inferInsert> = {},
	) => ({
		id,
		orgId: "org",
		workItemId,
		executorType: "external_agent" as const,
		executorId: "agent",
		executorSessionId: "session",
		externalSessionKey: "codex:session",
		runtimeState: "running" as const,
		attemptNumber: 1,
		startedAt: earlier,
		heartbeatAt: earlier,
		expiresAt: later,
		...extra,
	});
	for (const row of [
		attempt("a-running", "running"),
		attempt("a-failed-1", "failed", {
			runtimeState: "failed",
			outcome: "failed",
			startedAt: "2026-10-10T10:10:00.000Z",
			finishedAt: "2026-10-10T10:20:00.000Z",
		}),
		attempt("a-failed-2", "failed", {
			runtimeState: "failed",
			outcome: "failed",
			attemptNumber: 2,
			startedAt: "2026-10-10T10:30:00.000Z",
			finishedAt: "2026-10-10T10:40:00.000Z",
			summary: "Tests failed",
		}),
		// The lease ran out and nothing settled the Attempt.
		attempt("a-lapsed", "lapsed", { expiresAt: earlier }),
		attempt("a-elsewhere", "other-org", {
			orgId: "elsewhere",
		}),
	])
		await db.insert(workAttempts).values(row);
	const step = (attemptId: string, workItemId: string, seq: number) => ({
		id: `${attemptId}-${seq}`,
		orgId: "org",
		workItemId,
		attemptId,
		seq,
		at: 1_000 + seq,
		kind: "message" as const,
		text: `step ${seq}`,
	});
	await db
		.insert(workAttemptSteps)
		.values([
			step("a-running", "running", 1),
			step("a-running", "running", 2),
			step("a-failed-1", "failed", 9),
		]);
	const message = (
		id: string,
		kind: "follow_up" | "stop",
		appliedAt: string | null,
	) => ({
		id,
		orgId: "org",
		workItemId: "running",
		attemptId: "a-running",
		kind,
		body: kind === "stop" ? "" : "please",
		senderType: "user" as const,
		senderId: "owner",
		createdAt: earlier,
		appliedAt,
	});
	await db
		.insert(workAttemptMessages)
		.values([
			message("m-applied", "follow_up", earlier),
			message("m-waiting", "follow_up", null),
			message("m-stop", "stop", null),
		]);
	// A runner tried to start the waiting task twice; the newest try speaks.
	const admission = (
		id: string,
		createdAt: string,
		rejectionCode: string | null,
	) => ({
		id,
		orgId: "org",
		workItemId: "waiting",
		workItemVersion: 1,
		admissionSpecRevision: "r1",
		executorType: "external_agent" as const,
		executorId: "agent",
		decision: rejectionCode ? ("rejected" as const) : ("admitted" as const),
		rejectionCode,
		rejectionReason: rejectionCode ? "Lane retry budget exhausted" : null,
		rejectionKey: rejectionCode ? id : null,
		decidedAt: createdAt,
		expiresAt: later,
		createdAt,
	});
	await db
		.insert(workAdmissions)
		.values(admission("adm-1", "2026-10-10T10:00:30.000Z", null));
	await db
		.insert(workAdmissions)
		.values(
			admission("adm-2", "2026-10-10T10:00:40.000Z", "evaluation_required"),
		);
	return db;
}

describe("listAgentRuns", () => {
	it("lists one tedi's runs in its own organization with their real state", async () => {
		const db = await fixture();
		const runs = await listAgentRuns(db, {
			orgId: "org",
			stewardTediId: "tedi-a",
			state: "all",
			at: now,
		});
		expect(runs.map((run) => [run.workItem.id, run.state])).toEqual([
			["lapsed", "waiting_for_runner"],
			["failed", "ended"],
			["running", "running"],
			["waiting", "waiting_for_runner"],
		]);
		const byId = new Map(runs.map((run) => [run.workItem.id, run]));
		expect(byId.get("running")).toMatchObject({
			lastStep: { seq: 2, text: "step 2" },
			pendingFollowUps: 1,
			stop: { senderType: "user", senderId: "owner" },
			attemptCount: 1,
		});
		// The newest Attempt speaks for the run, not an earlier one.
		expect(byId.get("failed")).toMatchObject({
			attempt: { id: "a-failed-2", outcome: "failed", summary: "Tests failed" },
			attemptCount: 2,
			lastStep: null,
		});
		expect(byId.get("waiting")).toMatchObject({
			attempt: null,
			stop: null,
			refusedStart: {
				code: "evaluation_required",
				reason: "Lane retry budget exhausted",
			},
		});
		expect(byId.get("lapsed")?.refusedStart).toBeNull();
	});

	it("filters by state and never crosses a tedi or an organization", async () => {
		const db = await fixture();
		const ids = async (params: Parameters<typeof listAgentRuns>[1]) =>
			(await listAgentRuns(db, { ...params, at: now })).map(
				(run) => run.workItem.id,
			);
		expect(await ids({ orgId: "org", stewardTediId: "tedi-a" })).toEqual([
			"lapsed",
			"running",
			"waiting",
		]);
		expect(
			await ids({ orgId: "org", stewardTediId: "tedi-a", state: "ended" }),
		).toEqual(["failed"]);
		expect(
			await ids({ orgId: "org", stewardTediId: "tedi-b", state: "all" }),
		).toEqual(["other-tedi"]);
		expect(await ids({ orgId: "org", state: "all", limit: 2 })).toEqual([
			"other-tedi",
			"lapsed",
		]);
		expect(
			await ids({ orgId: "elsewhere", stewardTediId: "tedi-a", state: "all" }),
		).toEqual(["other-org"]);
		expect(
			await ids({ orgId: "nowhere", stewardTediId: "tedi-a", state: "all" }),
		).toEqual([]);
	});
});

describe("supervision of agent runs", () => {
	it("finds active tedis with an accepted run they started, in any organization", async () => {
		const db = await fixture();
		const sqlite = databases.at(-1)!;
		sqlite.exec(
			schemaDdl(organizations, tedis) +
				`INSERT INTO organizations(id,name,slug) VALUES('org','Example','example'),('elsewhere','Other','other'),('idle','Idle','idle');
				INSERT INTO tedis(id,organization_id,name,slug,status,runtime_overrides) VALUES
					('tedi-a','org','A','a','active','{"agentRunSupervision":{"enabled":false}}'),
					('tedi-b','org','B','b','paused',NULL),
					('tedi-c','idle','C','c','active',NULL);`,
		);
		// A paused tedi and an organization without runs are left out, and so
		// is a run whose steward belongs to another organization.
		const supervisors = () =>
			listAgentRunSupervisors(db, {
				since: "2026-09-10T12:00:00.000Z",
				limit: 10,
			});
		expect(await supervisors()).toEqual([
			{
				workItemIds: expect.arrayContaining([
					"waiting",
					"running",
					"failed",
					"lapsed",
				]),
				orgId: "org",
				tediId: "tedi-a",
				slug: "a",
				runtimeOverrides: { agentRunSupervision: { enabled: false } },
			},
		]);
		await db
			.update(workItems)
			.set({ disposition: "completed" })
			.where(eq(workItems.orgId, "org"));
		expect(await supervisors()).toEqual([]);
	});

	it("counts a round once when two ticks record it", async () => {
		const db = await fixture();
		const state = { rounds: 1, lastRoundAt: now, seen: "running:a:2:0:-" };
		const record = () =>
			recordAgentRunSupervisionRound(db, {
				orgId: "org",
				workItemId: "running",
				expectedRounds: 0,
				state,
			});
		expect(await record()).toBe(true);
		expect(await record()).toBe(false);
		expect(
			await recordAgentRunSupervisionRound(db, {
				orgId: "elsewhere",
				workItemId: "running",
				expectedRounds: 1,
				state,
			}),
		).toBe(false);
		const [run] = (
			await listAgentRuns(db, { orgId: "org", state: "all", at: now })
		).filter((row) => row.workItem.id === "running");
		expect(agentRunSupervisionState(run!.workItem.metadata)).toEqual(state);
		// The source that makes it an agent run survives the write.
		expect(run!.workItem.metadata?.source).toBe(AGENT_RUN_SOURCE);
		expect(agentRunSupervisionState({ agentRunSupervision: "x" })).toBeNull();
	});
});
