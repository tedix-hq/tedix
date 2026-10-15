/**
 * Ledger reads behind the MCP Events poll surface: every Work lifecycle
 * transition becomes exactly one `work.item.state_changed` row, cursors resume
 * after the last row, and no read crosses an organization boundary.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { skillRuns } from "../schema/cognitive";
import { workEvents } from "../schema/work-items";
import { createD1Facade } from "../test/d1-facade";
import { canonicalWorkFactoryDdl, schemaDdl } from "../test/schema-ddl";
import {
	getLatestFailedSkillRunPosition,
	listFailedSkillRunEvents,
} from "./skill-runs";
import {
	getLatestWorkApprovalPosition,
	listRequestedWorkApprovalEvents,
} from "./work-items/approvals";
import {
	acceptWorkItem,
	cancelWorkItem,
	completeWorkItem,
} from "./work-items/crud";
import {
	getWorkEventHeadSequence,
	listWorkStateChangeEvents,
} from "./work-items/events";

const ORG_A = "org-a";
const ORG_B = "org-b";
const NOW = "2026-10-15T12:00:00.000Z";
const actor = { type: "user" as const, id: "user-1" };

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(canonicalWorkFactoryDdl());
	sqlite.exec(schemaDdl(workEvents, skillRuns));
	sqlite.exec("PRAGMA foreign_keys = OFF");
	const seedItem = (id: string, org: string) =>
		sqlite
			.prepare(
				"INSERT INTO work_items(id,org_id,title,disposition,work_kind,created_at,work_class) VALUES(?,?,?,'proposed','coding',?,'maintenance')",
			)
			.run(id, org, id, NOW);
	return { sqlite, db: createDbQueryClient(createD1Facade(sqlite)), seedItem };
}

describe("work.item.state_changed ledger feed", () => {
	it("yields one row per accept, complete, cancel and attempt settle", async () => {
		const { sqlite, db, seedItem } = fixture();
		seedItem("done", ORG_A);
		seedItem("dropped", ORG_A);
		const start = await getWorkEventHeadSequence(db, ORG_A);
		const contract = { version: 1 as const, doneLooksLike: "Shipped" };
		await acceptWorkItem(db, {
			orgId: ORG_A,
			workItemId: "done",
			acceptanceContract: contract,
			actor,
		});
		sqlite
			.prepare(
				"INSERT INTO work_events(id,org_id,work_item_id,attempt_id,event_type,actor_type,actor_id,payload,occurred_at) VALUES('settle-1',?,'done','attempt-1','attempt.settled','tedi','tedi-1',?,?)",
			)
			.run(
				ORG_A,
				JSON.stringify({ outcome: "succeeded", summary: "private" }),
				NOW,
			);
		await completeWorkItem(db, { orgId: ORG_A, workItemId: "done", actor });
		await cancelWorkItem(db, {
			orgId: ORG_A,
			workItemId: "dropped",
			actor,
			reason: "private reason",
		});

		const rows = await listWorkStateChangeEvents(db, {
			orgId: ORG_A,
			afterSequence: start,
			limit: 50,
		});
		expect(rows.map((row) => [row.workItemId, row.eventType])).toEqual([
			["done", "work.accepted"],
			["done", "attempt.settled"],
			["done", "work.completed"],
			["dropped", "work.cancelled"],
		]);
		expect(rows[1]).toMatchObject({
			attemptId: "attempt-1",
			outcome: "succeeded",
		});
		expect(JSON.stringify(rows)).not.toContain("private");
	});

	it("resumes after a cursor and filters by Work Item", async () => {
		const { db, seedItem } = fixture();
		seedItem("one", ORG_A);
		seedItem("two", ORG_A);
		const contract = { version: 1 as const, doneLooksLike: "Done" };
		await acceptWorkItem(db, {
			orgId: ORG_A,
			workItemId: "one",
			acceptanceContract: contract,
			actor,
		});
		const cursor = await getWorkEventHeadSequence(db, ORG_A);
		await acceptWorkItem(db, {
			orgId: ORG_A,
			workItemId: "two",
			acceptanceContract: contract,
			actor,
		});
		await cancelWorkItem(db, { orgId: ORG_A, workItemId: "one", actor });

		const after = await listWorkStateChangeEvents(db, {
			orgId: ORG_A,
			afterSequence: cursor,
			limit: 50,
		});
		expect(after.map((row) => row.workItemId)).toEqual(["two", "one"]);
		const filtered = await listWorkStateChangeEvents(db, {
			orgId: ORG_A,
			afterSequence: 0,
			workItemId: "one",
			limit: 50,
		});
		expect(filtered.map((row) => row.eventType)).toEqual([
			"work.accepted",
			"work.cancelled",
		]);
	});

	it("never returns another organization's transitions", async () => {
		const { db, seedItem } = fixture();
		seedItem("mine", ORG_A);
		seedItem("theirs", ORG_B);
		const contract = { version: 1 as const, doneLooksLike: "Done" };
		await acceptWorkItem(db, {
			orgId: ORG_B,
			workItemId: "theirs",
			acceptanceContract: contract,
			actor,
		});
		expect(
			await listWorkStateChangeEvents(db, {
				orgId: ORG_A,
				afterSequence: 0,
				limit: 50,
			}),
		).toEqual([]);
		expect(await getWorkEventHeadSequence(db, ORG_A)).toBe(0);
		// Org A's own ledger head does not advance on org B activity.
		await acceptWorkItem(db, {
			orgId: ORG_A,
			workItemId: "mine",
			acceptanceContract: contract,
			actor,
		});
		const rows = await listWorkStateChangeEvents(db, {
			orgId: ORG_A,
			afterSequence: 0,
			limit: 50,
		});
		expect(rows.map((row) => row.workItemId)).toEqual(["mine"]);
	});
});

describe("work.approval.requested ledger feed", () => {
	it("pages ascending by keyset, omits bodies and isolates orgs", async () => {
		const { sqlite, db } = fixture();
		const insert = sqlite.prepare(
			"INSERT INTO work_approval_proposals(id,org_id,work_item_id,work_item_version,authority_key,action,proposal,requester_type,requester_id,approver_type,approver_id,status,rationale,expires_at,created_at) VALUES(?,?,?,1,'admission','admission',?,'tedi','tedi-1','user','user-1','pending','secret rationale','2026-10-16T00:00:00.000Z',?)",
		);
		insert.run("p1", ORG_A, "w1", '{"body":"secret"}', NOW);
		insert.run("p2", ORG_B, "w2", '{"body":"secret"}', NOW);
		insert.run(
			"p3",
			ORG_A,
			"w3",
			'{"body":"secret"}',
			"2026-10-15T12:05:00.000Z",
		);

		const all = await listRequestedWorkApprovalEvents(db, {
			orgId: ORG_A,
			after: null,
			limit: 50,
		});
		expect(all.map((row) => row.id)).toEqual(["p1", "p3"]);
		expect(JSON.stringify(all)).not.toContain("secret");
		const resumed = await listRequestedWorkApprovalEvents(db, {
			orgId: ORG_A,
			after: { at: NOW, id: "p1" },
			limit: 50,
		});
		expect(resumed.map((row) => row.id)).toEqual(["p3"]);
		expect(await getLatestWorkApprovalPosition(db, ORG_A)).toEqual({
			at: "2026-10-15T12:05:00.000Z",
			id: "p3",
		});
	});
});

describe("skill.run.failed ledger feed", () => {
	it("returns only failed runs of the org with a coarse error class", async () => {
		const { sqlite, db } = fixture();
		const insert = sqlite.prepare(
			"INSERT INTO skill_runs(id,organization_id,skill_id,tedi_id,workflow_instance_id,runtime_environment,status,error,completed_at) VALUES(?,?,'skill-1','tedi-1',?,'production',?,?,?)",
		);
		insert.run("r1", ORG_A, "wf1", "failed", "TypeError: secret stack", NOW);
		insert.run("r2", ORG_A, "wf2", "completed", null, NOW);
		insert.run("r3", ORG_B, "wf3", "failed", "boom", NOW);
		insert.run(
			"r4",
			ORG_A,
			"wf4",
			"failed",
			"WORKFLOW_ADMISSION_DENIED: budget",
			"2026-10-15T12:01:00.000Z",
		);

		const rows = await listFailedSkillRunEvents(db, {
			organizationId: ORG_A,
			after: null,
			limit: 50,
		});
		expect(rows.map((row) => [row.id, row.errorClass])).toEqual([
			["r1", "execution"],
			["r4", "admission"],
		]);
		expect(JSON.stringify(rows)).not.toContain("secret");
		expect(
			(
				await listFailedSkillRunEvents(db, {
					organizationId: ORG_A,
					after: { at: NOW, id: "r1" },
					limit: 50,
				})
			).map((row) => row.id),
		).toEqual(["r4"]);
		expect(await getLatestFailedSkillRunPosition(db, ORG_B)).toEqual({
			at: NOW,
			id: "r3",
		});
	});
});
