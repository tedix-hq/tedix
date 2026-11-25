import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { createMigratedSqlite } from "@tedix/db/test/migrated-sqlite";
import {
	advanceCommitmentWakeCheckpoint,
	listCommitmentChanges,
	listDueCommitmentWakes,
	retainCommitmentWakeChanges,
} from "@tedix/db/queries/work-items/commitment-changes";
import { buildRuntimeRunId } from "@tedix/api-contract/utils/runtime-identity";
import { dispatchCommitmentWakes } from "../jobs/commitment-wakes";
import {
	consumeAutomationEvents,
	handleAutomationEventMessage,
} from "../jobs/automation-events";

const after = "2026-10-22T08:00:00.000Z";
const changed = "2026-10-22T08:01:00.000Z";
const through = "2026-10-22T08:02:00.000Z";
const now = Date.parse(through) + 30_000;
createMigratedSqlite({ foreignKeys: false }).close();

function fixture() {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(Date, "now").mockReturnValue(now);
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	sqlite.exec(`INSERT INTO tedis(id,organization_id,name,slug,status,scope,owner_user_id)
	 VALUES ('worker','org-one','Worker','worker','active','organization',null),
	 ('personal','org-one','Personal','personal','active','personal','human');
	 INSERT INTO organization_members(id,organization_id,user_id,descope_user_id,email,status)
	 VALUES ('member','org-one','human','provider-human','human@example.test','active');
	 INSERT INTO work_items(admission_spec_revision,id,org_id,title,created_at,accepted_at,disposition,accountable_owner_type,accountable_owner_id)
	 VALUES ('test-spec','work','org-one','Commitment','${after}','${after}','accepted','tedi','worker');`);
	const plans: string[] = [];
	const binding = createD1Facade(
		{
			prepare(query) {
				if (/^select\b/i.test(query))
					plans.push(
						...sqlite
							.prepare(`EXPLAIN QUERY PLAN ${query}`)
							.all(...Array((query.match(/\?/g) ?? []).length).fill(null))
							.map((row) => String(row.detail)),
					);
				return sqlite.prepare(query);
			},
		},
		{ maxBoundParams: 100 },
	);
	const db = createDbClient(binding);
	const messages: unknown[] = [];
	const sendBatch = vi.fn(async (batch: { body: unknown }[]) => {
		messages.push(...batch.map((m) => m.body));
	});
	const fetch = vi.fn(async () =>
		Response.json({ accepted: true, run_id: "accepted" }),
	);
	const env = {
		DB: binding,
		ENVIRONMENT: "production",
		AUTOMATION_EVENTS: { sendBatch },
		TEDI_SERVICE: { fetch },
	} as unknown as CloudflareEnv;
	return { sqlite, db, messages, sendBatch, fetch, env, plans };
}

afterEach(() => vi.restoreAllMocks());

describe("commitment writer outbox", () => {
	it("covers every canonical change family, with targeted reads matching the catch-up scan", async () => {
		const f = fixture();
		f.sqlite.exec(`
		 INSERT INTO work_events(id,org_id,work_item_id,event_type,actor_type,actor_id,occurred_at)
		 VALUES ('event','org-one','work','work.accepted','user','human','${changed}');
		 INSERT INTO work_approval_proposals(id,org_id,work_item_id,work_item_version,authority_key,action,proposal,requester_type,requester_id,approver_type,approver_id,status,rationale,expires_at,created_at,resolved_at)
		 VALUES ('approval','org-one','work',1,'review','execute','{}','tedi','worker','user','human','pending','Review','2026-10-23T00:00:00.000Z','${after}',null);
		 INSERT INTO work_approval_decisions(id,proposal_id,resolved_proposal_version,decision,decider_type,decider_id,rationale,decided_at)
		 VALUES ('decision','approval',2,'approved','user','human','Reviewed','${changed}');
		 INSERT INTO tedi_approval_requests(id,tedi_id,org_id,action_type,description,payload,status,created_at,expires_at,resolved_at,resolved_by)
		 VALUES ('tedi-approval','worker','org-one','review','Review','{}','approved','${after}','2026-10-23T00:00:00.000Z','${changed}','human');
		 INSERT INTO work_interactions(id,org_id,work_item_id,kind,status,subject,prompt,creator_type,creator_id,target_type,target_id,due_at,created_at)
		 VALUES ('answer','org-one','work','question','open','Answer','Ready?','tedi','worker','user','human',null,'${after}'),
		 ('due','org-one','work','question','open','Due','Ready?','tedi','worker','user','human','${changed}','${after}'),
		 ('idle','org-one','work','question','open','Idle','Ready?','tedi','worker','user','human',null,'2026-10-20T08:01:00.000Z');
		 INSERT INTO work_interaction_responses(id,org_id,interaction_id,resolved_request_version,resolution_fence,responder_type,responder_id,body,response_kind,resolves_request,responded_at)
		 VALUES ('response','org-one','answer',2,'fence','user','human','Yes','answer',1,'${changed}');
		 INSERT INTO os_gadget_executions(id,organization_id,workspace_id,gadget_id,status,granted_capabilities,policy_decision,tedi_id,created_by_kind,created_by_id,created_at,completed_at,runtime_environment)
		 VALUES ('gadget','org-one','workspace','gadget','failed','[]','{}','worker','user','human','${after}','${changed}','production');
		 INSERT INTO skill_runs(id,organization_id,skill_id,tedi_id,workflow_instance_id,runtime_environment,status,completed_at,work_item_id)
		 VALUES ('skill','org-one','skill','worker','workflow','production','completed','${changed}','work'),
		 ('stage','org-one','skill','worker','stage-workflow','staging','completed','${changed}','work');
		 INSERT INTO work_items(admission_spec_revision,id,org_id,title,created_at,accepted_at,disposition,accountable_owner_type,accountable_owner_id,deadline)
		 VALUES ('test-spec','deadline','org-one','Deadline','${after}','${after}','accepted','tedi','worker','${changed}'),
		 ('test-spec','member-due','org-one','Due','${after}','${after}','accepted','user','human','${changed}'),
		 ('test-spec','member-idle','org-one','Idle','2026-10-20T08:01:00.000Z','2026-10-20T08:01:00.000Z','accepted','user','human',null);
		 INSERT INTO memory_facts(id,organization_id,tedi_id,content,fact_type,metadata)
		 VALUES ('memory','org-one','worker','Send proposal','commitment','{"dueAt":"${changed}"}');
		`);
		const scan = await listCommitmentChanges(
			f.db,
			after,
			through,
			"production",
		);
		expect(scan).toHaveLength(13);
		const due = await listDueCommitmentWakes(f.db, through, "production");
		expect(due.map((r) => r.sourceKind).sort()).toEqual(
			[
				"work_event",
				"work_approval",
				"tedi_approval",
				"interaction_response",
				"interaction",
				"interaction",
				"gadget",
				"skill",
				"work_item",
				"work_item",
				"work_item",
				"memory",
			].sort(),
		);
		const targeted = [];
		for (const source of due)
			targeted.push(
				...(await listCommitmentChanges(
					f.db,
					new Date(Date.parse(source.dueAt) - 1).toISOString(),
					source.dueAt,
					"production",
					{ limit: 100, cursor: null, source },
				)),
			);
		expect(targeted.sort((a, b) => a.key.localeCompare(b.key))).toEqual(
			scan.sort((a, b) => a.key.localeCompare(b.key)),
		);
		await retainCommitmentWakeChanges(f.db, scan);
		expect(
			await listDueCommitmentWakes(f.db, through, "production"),
		).toHaveLength(due.length);
		expect(
			(await listDueCommitmentWakes(f.db, through, "staging")).some(
				(r) => r.sourceId === "stage",
			),
		).toBe(true);
		f.sqlite.exec(
			"BEGIN; INSERT INTO work_events(id,org_id,work_item_id,event_type,actor_type,actor_id,occurred_at) VALUES ('rolled-back','org-one','work','work.accepted','user','human','2026-10-22T08:01:00.000Z'); ROLLBACK;",
		);
		expect(
			f.sqlite
				.prepare(
					"SELECT id FROM commitment_wake_outbox WHERE source_id = 'rolled-back'",
				)
				.all(),
		).toEqual([]);
	});

	it("publishes IDs without delivery, retries failed sends, and keeps receipt deduplication across catch-up", async () => {
		const f = fixture();
		f.sqlite.exec(
			`INSERT INTO work_events(id,org_id,work_item_id,event_type,actor_type,actor_id,occurred_at) VALUES ('event','org-one','work','work.accepted','user','human','${changed}');`,
		);
		await advanceCommitmentWakeCheckpoint(f.db, after);
		f.sendBatch.mockRejectedValueOnce(new Error("queue unavailable"));
		await expect(dispatchCommitmentWakes(f.env, now)).rejects.toThrow(
			"queue unavailable",
		);
		expect(
			await listDueCommitmentWakes(f.db, through, "production"),
		).toHaveLength(1);
		expect(await dispatchCommitmentWakes(f.env, now)).toEqual({
			queued: 1,
			catchupQueued: 1,
		});
		expect(f.fetch).not.toHaveBeenCalled();
		expect(f.plans).toContainEqual(
			expect.stringContaining("USING INDEX idx_commitment_wake_outbox_pending"),
		);
		expect(
			f.plans.some((line) => /SCAN commitment_wake_outbox\b/.test(line)),
		).toBe(false);
		expect(
			await listDueCommitmentWakes(f.db, through, "production"),
		).toHaveLength(0);
		const wake = f.messages.find(
			(m) => (m as { kind: string }).kind === "commitment_wake",
		);
		expect(await handleAutomationEventMessage(f.env, wake)).toBe("ack");
		expect(f.fetch).toHaveBeenCalledOnce();
		expect(await handleAutomationEventMessage(f.env, wake)).toBe("ack");
		expect(await handleAutomationEventMessage(f.env, f.messages.at(-1))).toBe(
			"ack",
		);
		expect(
			await listDueCommitmentWakes(
				f.db,
				new Date(now + 600_000).toISOString(),
				"production",
			),
		).toHaveLength(0);
		expect(f.fetch).toHaveBeenCalledOnce();
		expect(
			f.sqlite
				.prepare(
					"SELECT completed_at FROM commitment_wake_outbox WHERE source_id='event'",
				)
				.get(),
		).toEqual({ completed_at: new Date(now).toISOString() });
	});
	it("drains a burst over bounded ticks and retains a delayed busy or failed wake until acceptance", async () => {
		const f = fixture();
		const insert = f.sqlite.prepare(
			"INSERT INTO work_events(id,org_id,work_item_id,event_type,actor_type,actor_id,occurred_at) VALUES (?,'org-one','work','work.accepted','user','human',?)",
		);
		for (let i = 0; i < 30; i++) insert.run(`event-${i}`, changed);
		expect(await dispatchCommitmentWakes(f.env, now)).toEqual({
			queued: 25,
			catchupQueued: 1,
		});
		expect(await dispatchCommitmentWakes(f.env, now + 120_000)).toEqual({
			queued: 5,
			catchupQueued: 1,
		});
		const wakes = f.messages.filter(
			(m) => (m as { kind: string }).kind === "commitment_wake",
		);
		expect(wakes).toHaveLength(30);
		expect(new Set(wakes.map((m) => (m as { id: string }).id)).size).toBe(30);
		// Event rows remain deliverable beyond the scan's 15-minute age cutoff.
		vi.mocked(Date.now).mockReturnValue(now + 1_200_000);
		f.sqlite
			.exec(`INSERT INTO tedi_runtime_events(id,organization_id,tedi_id,kind,conversation_id,run_id,runtime_backend,created_at)
		 VALUES ('active','org-one','worker','run.started','worker:commitments:worker','previous','cloudflare-agents','${changed}');`);
		expect(await handleAutomationEventMessage(f.env, wakes[0])).toBe("retry");
		expect(f.fetch).not.toHaveBeenCalled();
		f.sqlite
			.exec(`INSERT INTO tedi_runtime_events(id,organization_id,tedi_id,kind,conversation_id,run_id,runtime_backend,created_at)
		 VALUES ('terminal','org-one','worker','run.completed','worker:commitments:worker','previous','cloudflare-agents','${through}');`);
		f.fetch.mockImplementation(
			async () => new Response("unavailable", { status: 503 }),
		);
		expect(await handleAutomationEventMessage(f.env, wakes[0])).toBe("retry");
		expect(
			f.sqlite
				.prepare(
					"SELECT count(*) AS pending FROM commitment_wake_outbox WHERE completed_at IS NULL",
				)
				.get(),
		).toEqual({ pending: 30 });
		f.fetch.mockImplementation(async () =>
			Response.json({ accepted: true, run_id: "accepted" }),
		);
		for (const wake of wakes)
			expect(await handleAutomationEventMessage(f.env, wake)).toBe("ack");
		expect(
			f.sqlite
				.prepare(
					"SELECT count(*) AS completed FROM commitment_wake_outbox WHERE completed_at IS NOT NULL",
				)
				.get(),
		).toEqual({ completed: 30 });
	});
	it("keeps different skill epochs at the same timestamp distinct from old receipts", async () => {
		const f = fixture();
		f.sqlite
			.exec(`INSERT INTO skill_runs(id,organization_id,skill_id,tedi_id,workflow_instance_id,runtime_environment,status,completed_at,work_item_id)
		 VALUES ('skill','org-one','skill','worker','workflow','production','completed','${changed}','work');`);
		await dispatchCommitmentWakes(f.env, now);
		expect(await handleAutomationEventMessage(f.env, f.messages[0])).toBe(
			"ack",
		);
		f.sqlite.exec(
			"UPDATE skill_runs SET execution_epoch = execution_epoch + 1 WHERE id='skill'",
		);
		await dispatchCommitmentWakes(f.env, now);
		const wakes = f.messages.filter(
			(m) => (m as { kind: string }).kind === "commitment_wake",
		);
		expect(wakes).toHaveLength(2);
		expect(wakes[0]).not.toEqual(wakes[1]);
		expect(await handleAutomationEventMessage(f.env, wakes[1])).toBe("ack");
		expect(f.fetch).toHaveBeenCalledTimes(2);
		const scan = await listCommitmentChanges(
			f.db,
			after,
			through,
			"production",
		);
		await retainCommitmentWakeChanges(f.db, scan);
		expect(
			await listDueCommitmentWakes(f.db, through, "production"),
		).toHaveLength(0);
	});

	it("waits for a preceding commitment ingress receipt before dispatching another from the batch", async () => {
		const f = fixture();
		f.sqlite
			.exec(`INSERT INTO work_events(id,org_id,work_item_id,event_type,actor_type,actor_id,occurred_at)
		 VALUES ('one','org-one','work','work.accepted','user','human','${changed}'),
		 ('two','org-one','work','work.specification_updated','user','human','${changed}');`);
		await dispatchCommitmentWakes(f.env, now);
		f.fetch.mockImplementation(async (request: Request) => {
			const body = (await request.json()) as { client_request_id: string };
			const runId = buildRuntimeRunId({
				tediId: "worker",
				surface: "mcp",
				turnKey: body.client_request_id,
			});
			f.sqlite
				.prepare(
					"INSERT INTO tedi_runtime_events(id,organization_id,tedi_id,kind,conversation_id,run_id,runtime_backend,created_at) VALUES ('started','org-one','worker','run.started','worker:commitments:worker',?,'cloudflare-agents',?)",
				)
				.run(runId, changed);
			return Response.json({ accepted: true, run_id: runId });
		});
		const messages = f.messages
			.filter((m) => (m as { kind: string }).kind === "commitment_wake")
			.map((body) => ({ body, ack: vi.fn(), retry: vi.fn() }));
		await consumeAutomationEvents(f.env, messages);
		expect(messages[0]!.ack).toHaveBeenCalledOnce();
		expect(messages[1]!.retry).toHaveBeenCalledOnce();
		expect(f.fetch).toHaveBeenCalledOnce();
	});
	it("resumes a single source with more than one recipient page without dropping or repeating a recipient", async () => {
		const f = fixture();
		const insert = f.sqlite.prepare(
			"INSERT INTO tedis(id,organization_id,name,slug,status,scope,owner_user_id) VALUES (?,'org-one','Personal',?,'active','personal','human')",
		);
		for (let i = 0; i < 26; i++) insert.run(`personal-${i}`, `personal-${i}`);
		f.sqlite
			.exec(`INSERT INTO work_items(admission_spec_revision,id,org_id,title,created_at,accepted_at,disposition,accountable_owner_type,accountable_owner_id,deadline)
		 VALUES ('test-spec','paged','org-one','Due','${after}','${after}','accepted','user','human','${changed}');
		 INSERT INTO work_interactions(metadata,id,org_id,work_item_id,kind,status,subject,prompt,creator_type,creator_id,target_type,target_id,created_at)
		 VALUES ('{"commitmentKey":"work:paged","dedupeKey":"work:paged:2026-10-22","decisionClass":"deadline.owner.commitment"}','followup','org-one','paged','question','open','Follow up: Due','Ready?','tedi','personal','user','human','${after}');`);
		await dispatchCommitmentWakes(f.env, now);
		const wake = f.messages[0];
		expect(await handleAutomationEventMessage(f.env, wake)).toBe("retry");
		expect(f.fetch).toHaveBeenCalledTimes(25);
		expect(await handleAutomationEventMessage(f.env, wake)).toBe("ack");
		expect(f.fetch).toHaveBeenCalledTimes(27);
		expect(await handleAutomationEventMessage(f.env, wake)).toBe("ack");
		expect(f.fetch).toHaveBeenCalledTimes(27);
	});
});
