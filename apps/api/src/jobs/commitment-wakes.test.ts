import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { tedis } from "@tedix/db/schema/tedis";
import {
	workItems,
	workEvents,
	workAttempts,
} from "@tedix/db/schema/work-items";
import {
	workApprovalProposals,
	workApprovalDecisions,
	workInteractions,
	workInteractionResponses,
} from "@tedix/db/schema/work-factory";
import { tediApprovalRequests } from "@tedix/db/schema/approvals";
import { osGadgetExecutions } from "@tedix/db/schema/os-workspaces";
import { skillRuns } from "@tedix/db/schema/cognitive";
import {
	listCommitmentChanges,
	lastCommitmentWakeCheckpoint,
} from "@tedix/db/queries/work-items/commitment-changes";
import { platformCronExecutions } from "@tedix/db/schema/platform-cron-executions";
import {
	buildCommitmentWakeRequest,
	commitmentWakeWindows,
} from "./commitment-wakes";

const after = "2026-10-16T12:00:00.000Z";
const through = "2026-10-16T12:02:00.000Z";
const changedAt = "2026-10-16T12:01:00.000Z";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		schemaDdl(
			tedis,
			workItems,
			workEvents,
			workAttempts,
			workApprovalProposals,
			workApprovalDecisions,
			workInteractions,
			workInteractionResponses,
			tediApprovalRequests,
			osGadgetExecutions,
			skillRuns,
			platformCronExecutions,
		),
	);
	sqlite.exec(`INSERT INTO tedis (id,organization_id,name,slug,status) VALUES ('worker-1','org-1','Orion','orion','active'),('worker-2','org-2','Lyra','lyra','active');
	INSERT INTO work_items(id,org_id,title,created_at,disposition,accountable_owner_type,accountable_owner_id) VALUES ('work-1','org-1','Scratch commitment','${after}','accepted','tedi','worker-1');`);
	return {
		sqlite,
		db: createDbClient(
			createD1Facade({
				prepare(query) {
					// The live D1 installation rejects the original eight-term scan.
					expect((query.match(/\bUNION\b/gi) ?? []).length).toBeLessThan(4);
					return sqlite.prepare(query);
				},
				exec: (query) => {
					sqlite.exec(query);
				},
			}),
		),
	};
}

describe("commitment wakes", () => {
	it("keeps the initial failed scan boundary until a successful cron receipt", async () => {
		const { sqlite, db } = fixture();
		expect(await lastCommitmentWakeCheckpoint(db)).toBeNull();
		sqlite.exec(
			`INSERT INTO platform_cron_executions(id,schedule_id,cron,scheduled_at,started_at,status,affected_row_counts,created_at) VALUES ('tick-1','commitment-wakes','*/2 * * * *','${after}','${after}','failure','{}','${after}'),('tick-2','commitment-wakes','*/2 * * * *','${through}','${through}','running','{}','${through}')`,
		);
		expect(await lastCommitmentWakeCheckpoint(db)).toBe(after);
		sqlite.exec(
			"UPDATE platform_cron_executions SET status='success' WHERE id='tick-2'",
		);
		expect(await lastCommitmentWakeCheckpoint(db)).toBe(through);
	});
	it("debounces until a whole window settles and replays the same windows after failure", () => {
		const now = Date.parse(through);
		expect(commitmentWakeWindows(null, now)).toEqual([
			{ after: "2026-10-16T11:58:00.000Z", through: after },
		]);
		expect(commitmentWakeWindows(after, now + 30_000)).toHaveLength(2);
		expect(commitmentWakeWindows(through, now + 30_000)).toEqual([
			{ after, through },
		]);
	});
	it("suppresses self writes, completed Work, unchanged records and foreign tenants", async () => {
		const { sqlite, db } = fixture();
		const event = sqlite.prepare(
			"INSERT INTO work_events(id,org_id,work_item_id,event_type,actor_type,actor_id,occurred_at) VALUES (?,?,?,?,?,?,?)",
		);
		event.run(
			"event-1",
			"org-1",
			"work-1",
			"work.accepted",
			"user",
			"operator",
			changedAt,
		);
		event.run(
			"self",
			"org-1",
			"work-1",
			"work.specification_updated",
			"tedi",
			"worker-1",
			changedAt,
		);
		event.run(
			"foreign",
			"org-2",
			"work-1",
			"work.accepted",
			"user",
			"operator",
			changedAt,
		);
		let changes = await listCommitmentChanges(db, after, through, "production");
		expect(changes.map((change) => change.key)).toEqual(["work:event-1"]);
		expect(changes[0]?.tediId).toBe("worker-1");
		sqlite.exec("UPDATE work_items SET disposition='completed'");
		expect(
			await listCommitmentChanges(db, after, through, "production"),
		).toEqual([]);
	});
	it("includes failed attempts and overdue owned commitments once at their crossing", async () => {
		const { sqlite, db } = fixture();
		sqlite.prepare("UPDATE work_items SET deadline=?").run(changedAt);
		sqlite
			.prepare(
				"INSERT INTO work_events(id,org_id,work_item_id,event_type,actor_type,actor_id,payload,occurred_at) VALUES ('failure','org-1','work-1','attempt.settled','system','runtime',?,?)",
			)
			.run(JSON.stringify({ outcome: "failed" }), changedAt);
		expect(
			(await listCommitmentChanges(db, after, through, "production"))
				.map((change) => change.state)
				.sort(),
		).toEqual(["failed", "overdue"]);
		expect(
			await listCommitmentChanges(
				db,
				through,
				"2026-10-16T12:04:00.000Z",
				"production",
			),
		).toEqual([]);
	});
	it("wakes the requester when another actor answers an Interaction", async () => {
		const { sqlite, db } = fixture();
		sqlite.exec(
			`INSERT INTO work_interactions(id,org_id,work_item_id,kind,subject,prompt,creator_type,creator_id,created_at,status) VALUES ('ask-1','org-1','work-1','question','Scratch question','Continue?','tedi','worker-1','${after}','resolved');`,
		);
		sqlite
			.prepare(
				"INSERT INTO work_interaction_responses(id,org_id,interaction_id,resolved_request_version,resolution_fence,responder_type,responder_id,body,response_kind,resolves_request,responded_at) VALUES ('answer-1','org-1','ask-1',1,'fence','user','operator','Proceed','answer',1,?)",
			)
			.run(changedAt);
		expect(
			(await listCommitmentChanges(db, after, through, "production")).map(
				(change) => change.state,
			),
		).toEqual(["answered"]);
		sqlite.exec(
			"UPDATE work_interaction_responses SET responder_type='tedi',responder_id='worker-1'",
		);
		expect(
			await listCommitmentChanges(db, after, through, "production"),
		).toEqual([]);
	});
	it("reads approval decisions and factory results and keeps AITL workflow continuations in their existing path", async () => {
		const { sqlite, db } = fixture();
		sqlite.exec(`INSERT INTO work_approval_proposals (id,org_id,work_item_id,work_item_version,authority_key,action,proposal,requester_type,requester_id,approver_type,approver_id,status,rationale,expires_at,created_at,resolved_at) VALUES ('proposal-1','org-1','work-1',1,'review','execute','{}','tedi','worker-1','user','operator','approved','Scratch review','2026-10-17T00:00:00.000Z','${after}','${changedAt}');
		INSERT INTO work_approval_decisions(id,proposal_id,resolved_proposal_version,decision,decider_type,decider_id,rationale,decided_at) VALUES ('decision-1','proposal-1',1,'approved','user','operator','Bounded','${changedAt}');
		INSERT INTO tedi_approval_requests(id,tedi_id,org_id,action_type,description,payload,status,created_at,expires_at,resolved_at,resolved_by,workflow_id) VALUES ('aitl-1','worker-1','org-1','scratch','Scratch approval','{}','approved','${after}','2026-10-17T00:00:00.000Z','${changedAt}','operator','workflow-1');
		INSERT INTO os_gadget_executions(id,organization_id,workspace_id,gadget_id,status,granted_capabilities,policy_decision,tedi_id,created_by_kind,created_by_id,created_at,completed_at,runtime_environment) VALUES ('run-1','org-1','workspace-1','gadget-1','failed','[]','{}','worker-1','user','operator','${after}','${changedAt}','production');`);
		expect(
			(await listCommitmentChanges(db, after, through, "production"))
				.map((change) => change.kind)
				.sort(),
		).toEqual(["approval", "factory_run"]);
		sqlite.exec(
			"UPDATE work_approval_decisions SET decider_type='tedi', decider_id='worker-1'",
		);
		expect(
			(await listCommitmentChanges(db, after, through, "production")).map(
				(change) => change.kind,
			),
		).toEqual(["factory_run"]);
	});
	it("isolates factory environments, requires a skill commitment, and avoids counting gadget runs twice", async () => {
		const { sqlite, db } = fixture();
		const insert = sqlite.prepare(
			"INSERT INTO skill_runs(id,organization_id,skill_id,tedi_id,workflow_instance_id,runtime_environment,status,completed_at,work_item_id) VALUES (?,'org-1','skill-1','worker-1',?,?,'completed',?,?)",
		);
		insert.run(
			"skill-prod",
			"workflow-prod",
			"production",
			changedAt,
			"work-1",
		);
		insert.run("skill-stage", "workflow-stage", "staging", changedAt, "work-1");
		insert.run(
			"skill-unlinked",
			"workflow-unlinked",
			"production",
			changedAt,
			null,
		);
		expect(
			(await listCommitmentChanges(db, after, through, "production")).map(
				(change) => change.objectId,
			),
		).toEqual(["skill-prod"]);
		sqlite.exec(
			`INSERT INTO os_gadget_executions(id,organization_id,workspace_id,gadget_id,status,granted_capabilities,policy_decision,tedi_id,created_by_kind,created_by_id,created_at,completed_at,runtime_environment,run_id) VALUES ('gadget-prod','org-1','workspace-1','gadget-1','completed','[]','{}','worker-1','user','operator','${after}','${changedAt}','production','skill-prod');`,
		);
		expect(
			(await listCommitmentChanges(db, after, through, "production")).map(
				(change) => change.objectId,
			),
		).toEqual(["gadget-prod"]);
		sqlite.exec(
			"UPDATE os_gadget_executions SET runtime_environment='staging'",
		);
		expect(
			(await listCommitmentChanges(db, after, through, "production")).map(
				(change) => change.objectId,
			),
		).toEqual(["skill-prod"]);
	});
	it("batches meaningful changes in one durable, replay-safe context turn", async () => {
		const changes = [
			{
				key: "work:event-1",
				orgId: "org-1",
				tediId: "worker-1",
				slug: "orion",
				kind: "work" as const,
				objectId: "work-1",
				state: "failed",
				changedAt,
			},
		];
		const request = buildCommitmentWakeRequest(changes, through, "production");
		const body = (await request.json()) as {
			client_request_id: string;
			text: string;
			metadata: object;
		};
		expect(body.client_request_id).toBe(
			(
				(await buildCommitmentWakeRequest(
					changes,
					through,
					"production",
				).json()) as typeof body
			).client_request_id,
		);
		expect(body.text).toContain("Read these exact canonical objects");
		expect(body.text).toContain("no approval or Work Attempt");
		expect(body.metadata).not.toHaveProperty("workItemId");
		expect(request.headers.get("X-Tedix-Host")).toBe("orion.tedi.tedix.dev");
	});
});
