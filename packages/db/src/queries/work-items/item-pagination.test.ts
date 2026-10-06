import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { listWorkItemAttempts } from "./attempts";
import { listWorkCases } from "./cases";
import { listWorkItemEvidence } from "./evidence";

const DDL = `
CREATE TABLE work_attempts(id TEXT PRIMARY KEY,admission_id TEXT,work_item_id TEXT NOT NULL,org_id TEXT NOT NULL,executor_type TEXT NOT NULL,executor_id TEXT NOT NULL,executor_session_id TEXT,external_session_key TEXT,run_id TEXT,runtime_state TEXT NOT NULL,outcome TEXT,attempt_number INTEGER NOT NULL,started_at TEXT NOT NULL,heartbeat_at TEXT NOT NULL,expires_at TEXT,finished_at TEXT,summary TEXT,version INTEGER NOT NULL DEFAULT 1,metadata TEXT NOT NULL DEFAULT '{}');
CREATE TABLE work_evidence(id TEXT PRIMARY KEY,work_item_id TEXT NOT NULL,org_id TEXT NOT NULL,attempt_id TEXT,claim_key TEXT NOT NULL,kind TEXT NOT NULL,uri TEXT NOT NULL,digest TEXT,media_type TEXT,label TEXT,submitted_by_type TEXT NOT NULL,submitted_by_id TEXT NOT NULL,submitted_by_session_id TEXT,disposition TEXT NOT NULL,reviewed_by_type TEXT,reviewed_by_id TEXT,reviewed_by_session_id TEXT,review_reason TEXT,submitted_at TEXT NOT NULL,reviewed_at TEXT,version INTEGER NOT NULL DEFAULT 1,metadata TEXT NOT NULL DEFAULT '{}');
CREATE TABLE work_cases(id TEXT PRIMARY KEY,org_id TEXT NOT NULL,project_id TEXT,objective_id TEXT,title TEXT NOT NULL,description TEXT,kind TEXT NOT NULL,stage TEXT NOT NULL,accountable_owner_type TEXT NOT NULL,accountable_owner_id TEXT NOT NULL,opened_at TEXT NOT NULL,target_resolution_at TEXT,closed_at TEXT,metadata TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL,updated_at TEXT,version INTEGER NOT NULL DEFAULT 1);
`;
function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(DDL);
	return { sqlite, db: createDbQueryClient(createD1Facade(sqlite)) };
}
const SAME = "2026-08-20T12:00:00.000Z",
	OLDER = "2026-08-20T11:00:00.000Z";

describe("per-item stable keyset pages", () => {
	it("continues attempts and evidence without gaps across equal timestamps", async () => {
		const { sqlite, db } = fixture();
		for (const id of ["a", "b", "c", "d", "e"]) {
			const at = id === "a" ? OLDER : SAME;
			sqlite
				.prepare(
					"INSERT INTO work_attempts(id,work_item_id,org_id,executor_type,executor_id,runtime_state,outcome,attempt_number,started_at,heartbeat_at,finished_at) VALUES(?, 'work','org','tedi','tedi','finished','succeeded',1,?,?,?)",
				)
				.run(`attempt-${id}`, at, at, at);
			sqlite
				.prepare(
					"INSERT INTO work_evidence(id,work_item_id,org_id,claim_key,kind,uri,submitted_by_type,submitted_by_id,disposition,submitted_at) VALUES(?,'work','org',?,'artifact',?,'tedi','tedi','accepted',?)",
				)
				.run(`evidence-${id}`, id, `urn:${id}`, at);
		}
		const attempts1 = await listWorkItemAttempts(db, {
			orgId: "org",
			workItemId: "work",
			limit: 2,
		});
		const attempts2 = await listWorkItemAttempts(db, {
			orgId: "org",
			workItemId: "work",
			limit: 2,
			cursor: attempts1.nextCursor!,
		});
		const attempts3 = await listWorkItemAttempts(db, {
			orgId: "org",
			workItemId: "work",
			limit: 2,
			cursor: attempts2.nextCursor!,
		});
		expect(
			[...attempts1.data, ...attempts2.data, ...attempts3.data].map(
				(row) => row.id,
			),
		).toEqual([
			"attempt-e",
			"attempt-d",
			"attempt-c",
			"attempt-b",
			"attempt-a",
		]);
		expect(attempts3.nextCursor).toBeNull();
		const evidence1 = await listWorkItemEvidence(db, {
			orgId: "org",
			workItemId: "work",
			limit: 2,
		});
		const evidence2 = await listWorkItemEvidence(db, {
			orgId: "org",
			workItemId: "work",
			limit: 2,
			cursor: evidence1.nextCursor!,
		});
		const evidence3 = await listWorkItemEvidence(db, {
			orgId: "org",
			workItemId: "work",
			limit: 2,
			cursor: evidence2.nextCursor!,
		});
		expect(
			[...evidence1.data, ...evidence2.data, ...evidence3.data].map(
				(row) => row.id,
			),
		).toEqual([
			"evidence-e",
			"evidence-d",
			"evidence-c",
			"evidence-b",
			"evidence-a",
		]);
		expect(evidence3.nextCursor).toBeNull();
	});

	it("continues case pages with createdAt and id as a deterministic tie-break", async () => {
		const { sqlite, db } = fixture();
		for (const id of ["a", "b", "c", "d", "e"]) {
			const at = id === "a" ? OLDER : SAME;
			sqlite
				.prepare(
					"INSERT INTO work_cases(id,org_id,title,kind,stage,accountable_owner_type,accountable_owner_id,opened_at,created_at) VALUES(?,'org',?,'incident','investigating','system','tedix',?,?)",
				)
				.run(`case-${id}`, id, at, at);
		}
		const first = await listWorkCases(db, { orgId: "org", limit: 2 }),
			second = await listWorkCases(db, {
				orgId: "org",
				limit: 2,
				cursor: first.nextCursor!,
			}),
			third = await listWorkCases(db, {
				orgId: "org",
				limit: 2,
				cursor: second.nextCursor!,
			});
		expect(
			[...first.data, ...second.data, ...third.data].map((row) => row.id),
		).toEqual(["case-e", "case-d", "case-c", "case-b", "case-a"]);
		expect(third.nextCursor).toBeNull();
	});
});
