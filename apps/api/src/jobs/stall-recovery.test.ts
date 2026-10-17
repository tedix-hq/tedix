import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { projects } from "@tedix/db/schema/projects";
import { tedis } from "@tedix/db/schema/tedis";
import { tediObjectives, tediTasks } from "@tedix/db/schema/tedi-objectives";
import { workItems, workAttempts } from "@tedix/db/schema/work-items";
import { workAgentSessions } from "@tedix/db/schema/work-agent-sessions";
import { skillRuns } from "@tedix/db/schema/cognitive";
import {
	osGadgetExecutions,
	osWorkspaceProjects,
} from "@tedix/db/schema/os-workspaces";
import {
	learningInteractionEvents,
	learningImprovementProposals,
} from "@tedix/db/schema/learning-feedback";
import {
	workInteractions,
	workInteractionAttention,
} from "@tedix/db/schema/work-factory";
import {
	listContinuityScopes,
	getStallReceipt,
} from "@tedix/db/queries/work-items/stall-recovery";
import {
	assessContinuity,
	recoverStall,
	buildStallResumeRequest,
	continuityPolicy,
	dispatchStallRecovery,
} from "./stall-recovery";
import { readContinuity } from "../lib/stall-attention";
import { listLearningImprovementProposals } from "@tedix/db/queries/learning-feedback";

const createdAt = "2026-10-14T12:00:00.000Z";
const now = "2026-10-17T12:00:00.000Z";
function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		schemaDdl(
			projects,
			tedis,
			tediObjectives,
			tediTasks,
			workItems,
			workAttempts,
			workAgentSessions,
			skillRuns,
			osGadgetExecutions,
			osWorkspaceProjects,
			learningInteractionEvents,
			learningImprovementProposals,
			workInteractions,
			workInteractionAttention,
		),
	);
	sqlite.exec(`INSERT INTO tedis(id,organization_id,name,slug,status) VALUES ('river','fictional-orchard','River','river','active'),('moss','fictional-forest','Moss','moss','active');
 INSERT INTO projects(id,org_id,key,name,lead_tedi_id,created_at) VALUES ('orchard','fictional-orchard','ORCHARD','Orchard growth','river','${createdAt}'),('forest','fictional-forest','FOREST','Forest growth','moss','${createdAt}');`);
	const db = createDbClient(createD1Facade(sqlite));
	const scope = async () =>
		(await listContinuityScopes(db, "", "fictional-orchard"))[0]!;
	const send = vi.fn(async () =>
		Response.json({ accepted: true, run_id: "resume-run" }),
	);
	const recover = async () => {
		const s = await scope();
		return recoverStall(
			db,
			s,
			await assessContinuity(db, s, Date.parse(now)),
			now,
			send,
			"production",
		);
	};
	return { sqlite, db, scope, send, recover };
}

describe("autonomous stall recovery", () => {
	it("defaults to 24h, preserves per-project settings and rejects unsafe thresholds", () => {
		expect(continuityPolicy(null).idleHours).toBe(24);
		expect(continuityPolicy('{"idleHours":48}').idleHours).toBe(48);
		expect(continuityPolicy('{"idleHours":0}').idleHours).toBe(24);
	});
	it("resumes once, keeps canonical IDs, and suppresses raw gaps until acceptance", async () => {
		const { db, scope, send, recover } = fixture();
		expect(
			(await readContinuity(db, "fictional-orchard", new Date(now))).stalls,
		).toEqual([]);
		expect(await recover()).toBe(true);
		expect(await recover()).toBe(false);
		expect(send).toHaveBeenCalledTimes(1);
		const s = await scope();
		const request = buildStallResumeRequest(
			s,
			await assessContinuity(db, s, Date.parse(now)),
			"production",
		);
		const body = (await request.json()) as {
			text: string;
			client_request_id: string;
			metadata: object;
		};
		expect(body.text).toContain("create ONE");
		expect(body.text).toContain("no approval");
		expect(body.metadata).toMatchObject({
			scopeId: "orchard",
			source: "stall_recovery",
		});
		expect(request.headers.get("X-Tedix-Host")).toBe("river.tedi.tedix.dev");
		expect(
			(await readContinuity(db, "fictional-orchard", new Date(now))).stalls[0],
		).toMatchObject({
			reason: "no open work — tedi asked to propose next goals",
			needsYou: false,
		});
		expect(
			(await readContinuity(db, "fictional-forest", new Date(now))).stalls,
		).toEqual([]);
	});
	it("retries failed acceptance with the same incident key and never records a false receipt", async () => {
		const { db, scope } = fixture();
		const s = await scope();
		const assessment = await assessContinuity(db, s, Date.parse(now));
		const send = vi.fn(
			async (_request: Request) =>
				new Response("temporarily unavailable", { status: 503 }),
		);
		await expect(
			recoverStall(db, s, assessment, now, send, "production"),
		).rejects.toThrow();
		expect(
			await getStallReceipt(db, s.orgId, `${assessment.incidentKey}:accepted`),
		).toBeNull();
		const first = await (send.mock.calls[0]![0] as Request).json();
		await expect(
			recoverStall(db, s, assessment, now, send, "production"),
		).rejects.toThrow();
		expect(await (send.mock.calls[1]![0] as Request).json()).toEqual(first);
	});
	it("counts actual completed Work for a promise even if lane activity is fresh", async () => {
		const { sqlite, db, scope, recover, send } = fixture();
		sqlite.prepare("UPDATE projects SET metadata=? WHERE id='orchard'").run(
			JSON.stringify({
				continuity: {
					cadence: {
						everyHours: 24,
						minResults: 1,
						description: "One delivered result daily",
					},
				},
			}),
		);
		sqlite.exec(
			`INSERT INTO work_agent_sessions(id,organization_id,user_id,harness,session_key,project_id,state,state_since,last_event_at,created_at,updated_at) VALUES ('lane','fictional-orchard','ada','codex','session','orchard','working','${now}','${now}','${now}','${now}');`,
		);
		const s = await scope();
		const missed = await assessContinuity(db, s, Date.parse(now));
		expect(missed).toMatchObject({
			idle: false,
			promise: { status: "missed", delivered: 0 },
		});
		expect(await recover()).toBe(true);
		expect(send).toHaveBeenCalledTimes(1);
		sqlite.exec(
			`INSERT INTO work_items(id,org_id,title,project_id,disposition,created_at,completed_at) VALUES ('result','fictional-orchard','Verified example result','orchard','completed','${createdAt}','2026-10-16T15:00:00.000Z'),('foreign-result','fictional-forest','Other result','orchard','completed','${createdAt}','2026-10-16T15:00:00.000Z');`,
		);
		expect(
			await assessContinuity(db, await scope(), Date.parse(now)),
		).toMatchObject({ promise: { status: "kept", delivered: 1 } });
	});
	it("records owner failures without cross-tenant dispatch and excludes paused projects", async () => {
		const { sqlite, db, recover, send } = fixture();
		sqlite.exec("UPDATE projects SET lead_tedi_id='moss' WHERE id='orchard'");
		expect(await recover()).toBe(false);
		expect(send).not.toHaveBeenCalled();
		const cause = sqlite
			.prepare(
				"SELECT metadata FROM learning_interaction_events WHERE organization_id='fictional-orchard'",
			)
			.get() as { metadata: string };
		expect(JSON.parse(cause.metadata).cause).toBe("no owner");
		sqlite.exec("UPDATE projects SET status='paused' WHERE id='orchard'");
		expect(await listContinuityScopes(db, "", "fictional-orchard")).toEqual([]);
	});
	it("tracks objective activity, avoids duplicate linked objectives and respects local lanes", async () => {
		const { sqlite, db, scope, recover } = fixture();
		sqlite.exec(
			`INSERT INTO tedi_objectives(id,org_id,tedi_id,title,status,created_at) VALUES ('mission','fictional-orchard','river','Fictional mission','active','${createdAt}');`,
		);
		expect(
			await listContinuityScopes(db, "", "fictional-orchard"),
		).toHaveLength(2);
		sqlite.exec(
			"UPDATE projects SET objective_id='mission' WHERE id='orchard'",
		);
		expect(
			await listContinuityScopes(db, "", "fictional-orchard"),
		).toHaveLength(1);
		sqlite.exec(
			`INSERT INTO work_agent_sessions(id,organization_id,user_id,harness,session_key,project_id,state,state_since,last_event_at,created_at,updated_at) VALUES ('lane','fictional-orchard','ada','codex','session','orchard','working','${now}','${now}','${now}','${now}');`,
		);
		expect((await scope()).lastActivityAt).toBe(now);
		expect(await recover()).toBe(false);
	});
	it("proposes a reviewed workflow fix after three distinct incidents, never on retries", async () => {
		const { db, scope, recover } = fixture();
		await recover();
		await recover();
		const s = await scope();
		const assessment = await assessContinuity(db, s, Date.parse(now));
		for (const suffix of ["second", "third", "fourth"])
			await recoverStall(
				db,
				s,
				{ ...assessment, incidentKey: `${assessment.incidentKey}:${suffix}` },
				now,
				async () => Response.json({ accepted: true, run_id: suffix }),
				"production",
			);
		const data = await listLearningImprovementProposals(db, {
			organizationId: s.orgId,
		});
		expect(data).toHaveLength(1);
		expect(data[0]?.status).toBe("proposed");
		expect(data[0]?.evidenceEventIds).toHaveLength(3);
	});
	it("shows only a specific open decision addressed to the viewer after recovery", async () => {
		const { sqlite, db, recover } = fixture();
		await recover();
		sqlite.exec(
			`INSERT INTO work_interactions(id,org_id,project_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,created_at) VALUES ('consent','fictional-orchard','orchard','question','Authorize the test connector?','Choose read access or keep it disconnected.','tedi','river','user','ada','${now}');`,
		);
		expect(
			(await readContinuity(db, "fictional-orchard", new Date(now), "", "ada"))
				.stalls[0],
		).toMatchObject({
			needsYou: true,
			reason: "waiting for your decision: Authorize the test connector?",
		});
		expect(
			(await readContinuity(db, "fictional-orchard", new Date(now), "", "bea"))
				.stalls[0]?.needsYou,
		).toBe(false);
		sqlite.exec("UPDATE work_interactions SET status='resolved'");
		expect(
			(await readContinuity(db, "fictional-orchard", new Date(now), "", "ada"))
				.stalls[0]?.needsYou,
		).toBe(false);
	});

	it("uses the configured coordinator when the owner is unavailable, retaining no-owner cause", async () => {
		const { sqlite, db, scope, recover, send } = fixture();
		sqlite
			.prepare(
				"UPDATE projects SET lead_tedi_id=NULL, metadata=? WHERE id='orchard'",
			)
			.run(JSON.stringify({ continuity: { coordinatorTediId: "river" } }));
		const assessment = await assessContinuity(
			db,
			await scope(),
			Date.parse(now),
		);
		expect(assessment.cause).toBe("no owner");
		expect(await recover()).toBe(true);
		expect(send).toHaveBeenCalledTimes(1);
	});
	it("does not re-wake a missed period when activity resumes or pending items change", async () => {
		const { sqlite, db, scope, recover, send } = fixture();
		sqlite.prepare("UPDATE projects SET metadata=? WHERE id='orchard'").run(
			JSON.stringify({
				continuity: {
					cadence: {
						everyHours: 24,
						minResults: 1,
						description: "One result daily",
					},
				},
			}),
		);
		const initial = await assessContinuity(db, await scope(), Date.parse(now));
		await recover();
		sqlite.exec(`INSERT INTO work_items(id,org_id,title,project_id,created_at,disposition) VALUES ('next','fictional-orchard','Next useful goal','orchard','${now}','accepted');
   INSERT INTO work_agent_sessions(id,organization_id,user_id,harness,session_key,project_id,state,state_since,last_event_at,created_at,updated_at) VALUES ('lane','fictional-orchard','ada','codex','session','orchard','working','${now}','${now}','${now}','${now}');`);
		const resumed = await assessContinuity(db, await scope(), Date.parse(now));
		expect(resumed.incidentKey).toBe(initial.incidentKey);
		expect(await recover()).toBe(false);
		expect(send).toHaveBeenCalledTimes(1);
	});
	it("continues other tenants after a failed acceptance, and retries only the failed wake", async () => {
		const { db } = fixture();
		let rejectForest = true;
		const fetch = vi.fn(async (request: Request) =>
			request.headers.get("X-Tedix-Host")?.startsWith("moss.") && rejectForest
				? new Response("unavailable", { status: 503 })
				: Response.json({ accepted: true, run_id: "accepted-run" }),
		);
		const env = {
			ENVIRONMENT: "production",
			TEDI_SERVICE: { fetch },
		} as unknown as CloudflareEnv;
		await expect(
			dispatchStallRecovery(db, env, Date.parse(now)),
		).rejects.toThrow("Stall recovery incomplete");
		expect(fetch).toHaveBeenCalledTimes(2);
		rejectForest = false;
		expect(await dispatchStallRecovery(db, env, Date.parse(now))).toBe(1);
		expect(fetch).toHaveBeenCalledTimes(3);
	});
	it("keeps a post-recovery decision visible after activity resets the idle clock", async () => {
		const { sqlite, db, recover } = fixture();
		await recover();
		sqlite.exec(`INSERT INTO work_interactions(id,org_id,project_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,created_at) VALUES ('decision','fictional-orchard','orchard','question','Choose the scope','Choose one of the three proposed goals.','tedi','river','user','ada','${now}');
   INSERT INTO work_agent_sessions(id,organization_id,user_id,harness,session_key,project_id,state,state_since,last_event_at,created_at,updated_at) VALUES ('lane','fictional-orchard','ada','codex','session','orchard','done','${now}','${now}','${now}','${now}');`);
		expect(
			(
				await readContinuity(
					db,
					"fictional-orchard",
					new Date(Date.parse(now) + 2 * 3_600_000),
					"",
					"ada",
				)
			).stalls[0]?.needsYou,
		).toBe(true);
	});
	it("treats malformed policy values as defaults and normalizes SQLite activity timestamps", async () => {
		const { sqlite, db, scope } = fixture();
		sqlite
			.prepare("UPDATE projects SET metadata=? WHERE id='orchard'")
			.run(JSON.stringify({ continuity: "invalid" }));
		expect((await scope()).policy).toBeNull();
		sqlite.exec(`INSERT INTO tedi_objectives(id,org_id,tedi_id,title,status,created_at) VALUES ('mission','fictional-orchard','river','Fictional mission','active','${createdAt}');
   UPDATE projects SET objective_id='mission' WHERE id='orchard';
   INSERT INTO tedi_tasks(id,org_id,tedi_id,objective_id,title,created_at,updated_at) VALUES ('task','fictional-orchard','river','mission','Example work','2026-10-17 13:00:00','2026-10-17 13:00:00');`);
		expect((await scope()).lastActivityAt).toBe("2026-10-17T13:00:00.000Z");
		expect(
			(await assessContinuity(db, await scope(), Date.parse(now))).idle,
		).toBe(false);
	});

	it("retries persistent idle failure once per own threshold and separates environments", async () => {
		const { db, scope } = fixture();
		const s = await scope();
		const first = await assessContinuity(db, s, Date.parse(now));
		const retry = await assessContinuity(db, s, Date.parse(now) + 86_400_000);
		const staging = await assessContinuity(db, s, Date.parse(now), "staging");
		expect(retry.incidentKey).not.toBe(first.incidentKey);
		expect(staging.incidentKey).not.toBe(first.incidentKey);
		await recoverStall(
			db,
			s,
			staging,
			now,
			async () => Response.json({ accepted: true, run_id: "staging-resume" }),
			"staging",
		);
		expect((await readContinuity(db, s.orgId, new Date(now))).stalls).toEqual(
			[],
		);
		expect(
			(
				await readContinuity(
					db,
					s.orgId,
					new Date(now),
					"",
					undefined,
					"staging",
				)
			).stalls,
		).toHaveLength(1);
	});

	it("keeps coordination updates out of Needs you unless server triage requires a decision", async () => {
		const { sqlite, db, recover } = fixture();
		await recover();
		sqlite.exec(
			`INSERT INTO work_interactions(id,org_id,project_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,created_at) VALUES ('update','fictional-orchard','orchard','coordination','Research is continuing','The worker resumed its queue.','tedi','river','user','ada','${now}');`,
		);
		const read = () =>
			readContinuity(db, "fictional-orchard", new Date(now), "", "ada");
		expect((await read()).stalls[0]?.needsYou).toBe(false);
		sqlite.exec(
			`INSERT INTO work_interaction_attention(org_id,interaction_id,kind,need,decided_at) VALUES ('fictional-orchard','update','needs_you',NULL,'${now}');`,
		);
		expect((await read()).stalls[0]?.needsYou).toBe(false);
		sqlite.exec(
			"UPDATE work_interaction_attention SET need='Choose which connector may be used'",
		);
		expect((await read()).stalls[0]).toMatchObject({
			needsYou: true,
			reason: "waiting for your decision: Choose which connector may be used",
		});
		sqlite.exec("UPDATE work_interaction_attention SET kind='fyi', need=NULL");
		expect((await read()).stalls[0]?.needsYou).toBe(false);
	});
});
