import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import {
	countPendingApprovalsByTedi,
	countReviewFlaggedSkillsByTedi,
	GOVERNANCE_AUDIT_ACTIONS,
	listGovernanceAuditEvents,
	summarizeCronExecutionsByTedi,
} from "./governance-overview";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE tedi_approval_requests (
			id TEXT PRIMARY KEY NOT NULL,
			tedi_id TEXT NOT NULL,
			org_id TEXT NOT NULL,
			action_type TEXT NOT NULL,
			description TEXT NOT NULL,
			payload TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			created_at TEXT NOT NULL,
			expires_at TEXT NOT NULL,
			resolved_at TEXT,
			resolved_by TEXT
		);
		CREATE TABLE skill_entries (
			id TEXT PRIMARY KEY NOT NULL,
			organization_id TEXT NOT NULL,
			tedi_id TEXT,
			title TEXT NOT NULL,
			content TEXT NOT NULL DEFAULT '# Skill',
			lifecycle_state TEXT DEFAULT 'draft',
			pace_layer TEXT NOT NULL DEFAULT 'innovation',
			review_flagged_at TEXT,
			review_flag_reason TEXT
		);
		CREATE TABLE tedi_cron_executions (
			id TEXT PRIMARY KEY NOT NULL,
			tedi_id TEXT NOT NULL,
			org_id TEXT NOT NULL,
			cron_name TEXT NOT NULL,
			fire_key TEXT NOT NULL,
			run_id TEXT,
			status TEXT NOT NULL DEFAULT 'running',
			started_at TEXT NOT NULL,
			finished_at TEXT,
			transitions TEXT,
			error TEXT,
			created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
		);
		CREATE TABLE audit_events (
			id TEXT PRIMARY KEY NOT NULL,
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
	`);
	return { db: createDbClient(createD1Facade(sqlite)), sqlite };
}

const ORG = "org-1";

describe("governance-overview queries on an empty org", () => {
	it("every read returns an empty grouped result", async () => {
		const { db } = fixture();
		expect(await countPendingApprovalsByTedi(db, ORG)).toEqual([]);
		expect(await countReviewFlaggedSkillsByTedi(db, ORG)).toEqual([]);
		expect(
			await summarizeCronExecutionsByTedi(db, ORG, "2026-07-15T00:00:00Z"),
		).toEqual([]);
		expect(await listGovernanceAuditEvents(db, ORG)).toEqual([]);
	});
});

describe("countPendingApprovalsByTedi", () => {
	it("groups pending rows per tedi, ignoring resolved rows and other orgs", async () => {
		const { db, sqlite } = fixture();
		const insert = sqlite.prepare(
			`INSERT INTO tedi_approval_requests (id, tedi_id, org_id, action_type, description, payload, status, created_at, expires_at)
			 VALUES (?, ?, ?, 'deploy', 'd', '{}', ?, '2026-07-16T00:00:00Z', '2026-07-17T00:00:00Z')`,
		);
		insert.run("a1", "tedi-1", ORG, "pending");
		insert.run("a2", "tedi-1", ORG, "pending");
		insert.run("a3", "tedi-2", ORG, "pending");
		insert.run("a4", "tedi-1", ORG, "approved");
		insert.run("a5", "tedi-1", "org-2", "pending");

		const counts = await countPendingApprovalsByTedi(db, ORG);
		expect(new Map(counts.map((row) => [row.tediId, row.count]))).toEqual(
			new Map([
				["tedi-1", 2],
				["tedi-2", 1],
			]),
		);
	});
});

describe("countReviewFlaggedSkillsByTedi", () => {
	it("counts flagged non-archived skills, with an org-scoped NULL bucket", async () => {
		const { db, sqlite } = fixture();
		const insert = sqlite.prepare(
			`INSERT INTO skill_entries (id, organization_id, tedi_id, title, lifecycle_state, review_flagged_at)
			 VALUES (?, ?, ?, 'S', ?, ?)`,
		);
		insert.run("s1", ORG, "tedi-1", "crystallized", "2026-07-16T00:00:00Z");
		insert.run("s2", ORG, null, "crystallized", "2026-07-16T00:00:00Z");
		// Not flagged.
		insert.run("s3", ORG, "tedi-1", "active", null);
		// Flagged but archived — out of scope.
		insert.run("s4", ORG, "tedi-1", "archived", "2026-07-16T00:00:00Z");
		// Other org.
		insert.run("s5", "org-2", "tedi-1", "crystallized", "2026-07-16T00:00:00Z");

		const counts = await countReviewFlaggedSkillsByTedi(db, ORG);
		expect(new Map(counts.map((row) => [row.tediId, row.count]))).toEqual(
			new Map<string | null, number>([
				["tedi-1", 1],
				[null, 1],
			]),
		);
	});
});

describe("summarizeCronExecutionsByTedi", () => {
	it("windows by started_at and summarizes fires/failures/last fire", async () => {
		const { db, sqlite } = fixture();
		const insert = sqlite.prepare(
			`INSERT INTO tedi_cron_executions (id, tedi_id, org_id, cron_name, fire_key, status, started_at, created_at)
			 VALUES (?, ?, ?, 'brain-reflection', ?, ?, ?, ?)`,
		);
		insert.run(
			"c1",
			"tedi-1",
			ORG,
			"f1",
			"success",
			"2026-07-16T06:00:00Z",
			"x",
		);
		insert.run(
			"c2",
			"tedi-1",
			ORG,
			"f2",
			"failure",
			"2026-07-16T08:00:00Z",
			"x",
		);
		insert.run(
			"c3",
			"tedi-1",
			ORG,
			"f3",
			"running",
			"2026-07-16T09:00:00Z",
			"x",
		);
		// Outside the window.
		insert.run(
			"c4",
			"tedi-1",
			ORG,
			"f0",
			"failure",
			"2026-07-14T00:00:00Z",
			"x",
		);
		// Other org.
		insert.run(
			"c5",
			"tedi-9",
			"org-2",
			"f9",
			"success",
			"2026-07-16T09:00:00Z",
			"x",
		);

		const rows = await summarizeCronExecutionsByTedi(
			db,
			ORG,
			"2026-07-15T12:00:00Z",
		);
		expect(rows).toEqual([
			{
				tediId: "tedi-1",
				fires: 3,
				failures: 1,
				lastFireAt: "2026-07-16T09:00:00Z",
			},
		]);
	});
});

describe("listGovernanceAuditEvents", () => {
	it("returns only governance actions, newest first, capped", async () => {
		const { db, sqlite } = fixture();
		const insert = sqlite.prepare(
			`INSERT INTO audit_events (id, organization_id, actor_id, actor_type, action, resource_type, resource_id, timestamp)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		const base = Math.floor(Date.parse("2026-07-16T00:00:00Z") / 1000);
		insert.run(
			"e1",
			ORG,
			"user-1",
			"user",
			"tedi.config_change",
			"tedi",
			"t1",
			base + 100,
		);
		insert.run(
			"e2",
			ORG,
			"system",
			"service",
			"approval.approved",
			"approval",
			"a1",
			base + 200,
		);
		// Non-governance action — excluded.
		insert.run(
			"e3",
			ORG,
			"user-1",
			"user",
			"app.created",
			"app",
			"app1",
			base + 300,
		);
		// Other org — excluded.
		insert.run(
			"e4",
			"org-2",
			"user-1",
			"user",
			"tedi.config_change",
			"tedi",
			"t2",
			base + 400,
		);

		const rows = await listGovernanceAuditEvents(db, ORG, 10);
		expect(rows.map((row) => row.action)).toEqual([
			"approval.approved",
			"tedi.config_change",
		]);
		expect(rows[0]?.timestamp).toBeInstanceOf(Date);

		const capped = await listGovernanceAuditEvents(db, ORG, 1);
		expect(capped).toHaveLength(1);
	});

	it("only queries actions that have live writers (no aspirational kinds)", () => {
		// Gate graduations and mutation-gate rejections write NO audit row —
		// they must never appear in this list (the overview derives/declares
		// them separately).
		expect(GOVERNANCE_AUDIT_ACTIONS).not.toContain("gate_graduation");
		expect(GOVERNANCE_AUDIT_ACTIONS).not.toContain("mutation_gate_rejection");
	});
});
