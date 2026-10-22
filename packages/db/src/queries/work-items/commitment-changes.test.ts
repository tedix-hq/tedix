import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import { createD1Facade } from "../../test/d1-facade";
import { DatabaseSync } from "node:sqlite";
import { schemaDdl } from "../../test/schema-ddl";
import { tedis } from "../../schema/tedis";
import { organizationMembers } from "../../schema/organization-members";
import { memoryFacts } from "../../schema/memory-graph";
import { projects } from "../../schema/projects";
import { workItems, workEvents, workAttempts } from "../../schema/work-items";
import {
	workInteractions,
	workInteractionResponses,
	workApprovalProposals,
	workApprovalDecisions,
} from "../../schema/work-factory";
import { tediApprovalRequests } from "../../schema/approvals";
import { osGadgetExecutions } from "../../schema/os-workspaces";
import { skillRuns } from "../../schema/cognitive";
import { listCommitmentChanges } from "./commitment-changes";

const after = "2026-10-22T08:00:00.000Z";
const through = "2026-10-22T08:02:00.000Z";
const due = "2026-10-22T08:01:00.000Z";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		schemaDdl(
			tedis,
			organizationMembers,
			memoryFacts,
			projects,
			workItems,
			workEvents,
			workAttempts,
			workInteractions,
			workInteractionResponses,
			workApprovalProposals,
			workApprovalDecisions,
			tediApprovalRequests,
			osGadgetExecutions,
			skillRuns,
		),
	);
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(`
		INSERT INTO tedis(id,organization_id,name,slug,status,scope,owner_user_id)
		VALUES ('personal','org-one','Personal','personal','active','personal','provider-user');
		INSERT INTO organization_members(id,organization_id,user_id,descope_user_id,email,status)
		VALUES ('member','org-one','human','provider-user','human@example.test','active');
		INSERT INTO work_items(id,org_id,title,created_at,accepted_at,disposition,accountable_owner_type,accountable_owner_id)
		VALUES ('idle','org-one','Send proposal','2026-10-20T08:01:00.000Z','2026-10-20T08:01:00.000Z','accepted','user','human');
	`);
	const db = createDbClient(createD1Facade(sqlite, { maxBoundParams: 100 }));
	return { sqlite, db };
}

describe("member commitment changes", () => {
	it("returns an idle accepted item for its member's personal tedi", async () => {
		const { db } = fixture();
		expect(
			await listCommitmentChanges(db, after, through, "production"),
		).toEqual([
			expect.objectContaining({
				objectId: "idle",
				state: "idle",
				tediId: "personal",
			}),
		]);
	});

	it("excludes active Attempts, terminal Work, and other members", async () => {
		const { sqlite, db } = fixture();
		sqlite.exec(`INSERT INTO work_attempts(id,org_id,work_item_id,attempt_number,executor_type,executor_id,runtime_state,started_at,heartbeat_at,expires_at)
		VALUES ('attempt','org-one','idle',1,'tedi','personal','running','${after}','${after}','2026-10-22T09:00:00.000Z');`);
		expect(
			await listCommitmentChanges(db, after, through, "production"),
		).toEqual([]);
		sqlite.exec(
			"DELETE FROM work_attempts; UPDATE work_items SET disposition='completed'",
		);
		expect(
			await listCommitmentChanges(db, after, through, "production"),
		).toEqual([]);
		sqlite.exec(
			"UPDATE work_items SET disposition='accepted', accountable_owner_id='someone-else'",
		);
		expect(
			await listCommitmentChanges(db, after, through, "production"),
		).toEqual([]);
	});

	it("returns an overdue member interaction and deadline, excluding resolved interactions", async () => {
		const { sqlite, db } = fixture();
		sqlite.exec(`UPDATE work_items SET accepted_at='${after}', deadline='${due}';
		INSERT INTO work_interactions(id,org_id,work_item_id,kind,status,subject,prompt,creator_type,creator_id,target_type,target_id,due_at,created_at)
		VALUES ('ask','org-one','idle','question','open','Proposal','Ready?','user','human','user','human','${due}','${after}');`);
		const changes = await listCommitmentChanges(
			db,
			after,
			through,
			"production",
		);
		expect(
			changes.map(({ objectId, state }) => [objectId, state]).sort(),
		).toEqual([
			["ask", "overdue"],
			["idle", "overdue"],
		]);
		sqlite.exec("UPDATE work_interactions SET status='resolved'");
		expect(
			(await listCommitmentChanges(db, after, through, "production")).map(
				(x) => x.objectId,
			),
		).toEqual(["idle"]);
	});

	it("returns unanswered interactions without a deadline after 48 hours", async () => {
		const { sqlite, db } = fixture();
		sqlite.exec(`UPDATE work_items SET accepted_at='${after}';
		INSERT INTO work_interactions(id,org_id,work_item_id,kind,status,subject,prompt,creator_type,creator_id,target_type,target_id,created_at)
		VALUES ('ask','org-one','idle','question','open','Proposal','Ready?','tedi','personal','user','human','2026-10-20T08:01:00.000Z');`);
		expect(
			await listCommitmentChanges(db, after, through, "production"),
		).toEqual([expect.objectContaining({ objectId: "ask", state: "idle" })]);
	});

	it("returns a dated memory commitment only while it is current", async () => {
		const { sqlite, db } = fixture();
		sqlite.exec(`UPDATE work_items SET accepted_at='${after}';
		INSERT INTO memory_facts(id,organization_id,tedi_id,content,fact_type,metadata)
		VALUES ('promise','org-one','personal','I will send the proposal','commitment','{"dueAt":"${due}","personId":"human"}');`);
		expect(
			await listCommitmentChanges(db, after, through, "production"),
		).toEqual([
			expect.objectContaining({
				kind: "memory",
				objectId: "promise",
				state: "overdue",
			}),
		]);
		sqlite.exec(
			"UPDATE memory_facts SET archived_at='2026-10-22T08:01:30.000Z'",
		);
		expect(
			await listCommitmentChanges(db, after, through, "production"),
		).toEqual([]);
	});
});
