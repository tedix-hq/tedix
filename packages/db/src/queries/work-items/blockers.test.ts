import {
	workApprovalProposals,
	workApprovalDecisions,
} from "../../schema/work-factory";
import { schemaDdl } from "../../test/schema-ddl";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { deriveWorkItemReadiness } from "./readiness";
import {
	addWorkItemRelation,
	findWorkItemsBlockedBy,
	firstNonTerminalBlocker,
	queryWorkItemBlockers,
} from "./relations";

const NOW = "2026-08-20T12:00:00.000Z";
const DDL = `
${schemaDdl(workApprovalProposals, workApprovalDecisions)}
CREATE TABLE work_items (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT, disposition TEXT NOT NULL DEFAULT 'proposed', work_kind TEXT NOT NULL DEFAULT 'other', risk_level TEXT NOT NULL DEFAULT 'medium', acceptance_contract TEXT, required_capabilities TEXT NOT NULL DEFAULT '[]', required_authorities TEXT NOT NULL DEFAULT '[]', admission_spec_revision TEXT NOT NULL DEFAULT 'test-revision', priority TEXT NOT NULL DEFAULT 'medium', accountable_owner_type TEXT, accountable_owner_id TEXT, steward_type TEXT, steward_id TEXT, reviewer_type TEXT, reviewer_id TEXT, reviewer_lease_expires_at TEXT, objective_id TEXT, work_class TEXT, purpose_exception_expires_at TEXT, project_id TEXT, parent_work_item_id TEXT, source_session_key TEXT, source_intent_id TEXT, due_date TEXT, deadline TEXT, start_at TEXT, duration_days INTEGER, provenance TEXT DEFAULT '{}', metadata TEXT DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT, accepted_at TEXT, completed_at TEXT, cancelled_at TEXT, version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE work_item_relations (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, from_work_item_id TEXT NOT NULL, to_work_item_id TEXT NOT NULL, relation_type TEXT NOT NULL, metadata TEXT DEFAULT '{}', created_at TEXT NOT NULL);
CREATE TABLE work_attempts (id TEXT PRIMARY KEY, admission_id TEXT, work_item_id TEXT NOT NULL, org_id TEXT NOT NULL, executor_type TEXT NOT NULL, executor_id TEXT NOT NULL, executor_session_id TEXT, external_session_key TEXT, run_id TEXT, runtime_state TEXT NOT NULL, outcome TEXT, attempt_number INTEGER NOT NULL, started_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL, expires_at TEXT, finished_at TEXT, summary TEXT, version INTEGER NOT NULL DEFAULT 1, metadata TEXT NOT NULL DEFAULT '{}');
CREATE TABLE work_resource_requirements (org_id TEXT NOT NULL,work_item_id TEXT NOT NULL,resource_key TEXT NOT NULL,quantity INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(org_id,work_item_id,resource_key));
CREATE TABLE work_budget_envelopes (id TEXT PRIMARY KEY,org_id TEXT NOT NULL,scope_type TEXT NOT NULL,scope_id TEXT NOT NULL,limit_micros INTEGER NOT NULL,reservation_micros INTEGER NOT NULL,currency TEXT NOT NULL DEFAULT 'USD',enabled INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT,version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE work_case_items (id TEXT PRIMARY KEY,org_id TEXT NOT NULL,case_id TEXT NOT NULL,work_item_id TEXT NOT NULL,discovered_at TEXT NOT NULL,rationale TEXT);
`;

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(DDL);
	const db = createDbQueryClient(createD1Facade(sqlite));
	const seed = (id: string, disposition = "accepted", orgId = "org") =>
		sqlite
			.prepare(
				"INSERT INTO work_items (id,org_id,title,disposition,created_at,accepted_at,work_class,purpose_exception_expires_at) VALUES (?,?,?,?,?,?,'maintenance','2026-08-21T12:00:00.000Z')",
			)
			.run(
				id,
				orgId,
				id,
				disposition,
				NOW,
				disposition === "accepted" ? NOW : null,
			);
	return { sqlite, db, seed };
}

describe("canonical Work Item dependencies", () => {
	it("reads blockers and dependents in the canonical blocks direction", async () => {
		const { db, seed } = fixture();
		seed("blocker");
		seed("dependent");
		await addWorkItemRelation(db, {
			id: "r",
			orgId: "org",
			fromWorkItemId: "blocker",
			toWorkItemId: "dependent",
			relationType: "blocks",
			createdAt: NOW,
		});
		expect(
			(await queryWorkItemBlockers(db, "dependent", "org")).map((x) => x.id),
		).toEqual(["blocker"]);
		expect(
			(await findWorkItemsBlockedBy(db, "blocker", "org")).map((x) => x.id),
		).toEqual(["dependent"]);
	});

	it("returns no blockers when no edge exists", async () => {
		const { db, seed } = fixture();
		seed("item");
		expect(await queryWorkItemBlockers(db, "item", "org")).toEqual([]);
	});

	it("keeps accepted dependencies blocked until every blocker is terminal", async () => {
		const { sqlite, db, seed } = fixture();
		seed("a");
		seed("b");
		seed("target");
		for (const id of ["a", "b"])
			await addWorkItemRelation(db, {
				id: `r-${id}`,
				orgId: "org",
				fromWorkItemId: id,
				toWorkItemId: "target",
				relationType: "blocks",
				createdAt: NOW,
			});
		expect(
			(
				await deriveWorkItemReadiness(db, {
					orgId: "org",
					workItemId: "target",
					budgetAdmissible: true,
					resourcesAvailable: true,
					derivedAt: NOW,
				})
			).state,
		).toBe("dependencies_blocked");
		sqlite
			.prepare("UPDATE work_items SET disposition='completed' WHERE id='a'")
			.run();
		expect(
			(
				await deriveWorkItemReadiness(db, {
					orgId: "org",
					workItemId: "target",
					derivedAt: NOW,
				})
			).state,
		).toBe("dependencies_blocked");
		sqlite
			.prepare("UPDATE work_items SET disposition='cancelled' WHERE id='b'")
			.run();
		expect(
			(
				await deriveWorkItemReadiness(db, {
					orgId: "org",
					workItemId: "target",
					budgetAdmissible: true,
					resourcesAvailable: true,
					derivedAt: NOW,
				})
			).state,
		).toBe("ready");
	});

	it.each(["completed", "cancelled"])(
		"treats %s as a terminal blocker disposition",
		async (disposition) => {
			const { db, seed } = fixture();
			seed("blocker", disposition);
			seed("target");
			await addWorkItemRelation(db, {
				id: "r",
				orgId: "org",
				fromWorkItemId: "blocker",
				toWorkItemId: "target",
				relationType: "blocks",
				createdAt: NOW,
			});
			expect(await firstNonTerminalBlocker(db, "target", "org")).toBeNull();
		},
	);

	it("rejects cross-organization relation endpoints", async () => {
		const { db, seed } = fixture();
		seed("a", "accepted", "org");
		seed("b", "accepted", "other");
		await expect(
			addWorkItemRelation(db, {
				id: "r",
				orgId: "org",
				fromWorkItemId: "a",
				toWorkItemId: "b",
				relationType: "blocks",
				createdAt: NOW,
			}),
		).rejects.toThrow("Both relation endpoints");
	});

	it("rejects self-relations", async () => {
		const { db, seed } = fixture();
		seed("a");
		await expect(
			addWorkItemRelation(db, {
				id: "r",
				orgId: "org",
				fromWorkItemId: "a",
				toWorkItemId: "a",
				relationType: "blocks",
				createdAt: NOW,
			}),
		).rejects.toThrow("cannot relate to itself");
	});
});
