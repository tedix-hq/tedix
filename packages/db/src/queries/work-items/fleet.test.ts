import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { getWorkFleetProjection } from "./fleet";

const DDL = `
CREATE TABLE work_items (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, disposition TEXT NOT NULL,
	 admission_spec_revision TEXT NOT NULL DEFAULT 'revision-1'
);
CREATE TABLE work_attempts (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, work_item_id TEXT NOT NULL,
 admission_id TEXT, runtime_state TEXT NOT NULL, expires_at TEXT
);
CREATE TABLE work_admissions (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, work_item_id TEXT NOT NULL,
 admission_spec_revision TEXT NOT NULL, decision TEXT NOT NULL,
 created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE work_approval_proposals (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, status TEXT NOT NULL,
 expires_at TEXT NOT NULL
);
CREATE TABLE work_interactions (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, status TEXT NOT NULL,
 due_at TEXT, expires_at TEXT
);
CREATE TABLE work_resource_pools (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, resource_key TEXT NOT NULL,
 capacity INTEGER NOT NULL, enabled INTEGER NOT NULL
);
CREATE TABLE work_resource_reservations (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, pool_id TEXT NOT NULL,
 quantity INTEGER NOT NULL, state TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE work_budget_envelopes (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, scope_type TEXT NOT NULL,
 limit_micros INTEGER NOT NULL, enabled INTEGER NOT NULL
);
CREATE TABLE work_budget_reservations (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, envelope_id TEXT NOT NULL,
 amount_micros INTEGER NOT NULL, consumed_micros INTEGER,
 state TEXT NOT NULL, expires_at TEXT NOT NULL
);
`;

describe("Work fleet projection", () => {
	it("executes all aggregate reads as one D1-safe batch", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(DDL);
		sqlite.exec(`
			INSERT INTO work_items (id,org_id,disposition) VALUES ('item','org-a','accepted');
			INSERT INTO work_attempts (id,org_id,work_item_id,runtime_state,expires_at)
			VALUES ('attempt','org-a','item','running','2026-08-21T05:00:00.000Z');
			INSERT INTO work_resource_pools (id,org_id,resource_key,capacity,enabled)
			VALUES ('pool','org-a','browser',2,1);
			INSERT INTO work_resource_reservations
			(id,org_id,pool_id,quantity,state,expires_at)
			VALUES ('reservation','org-a','pool',1,'active','2026-08-21T05:00:00.000Z');
		`);

		const projection = await getWorkFleetProjection(
			createDbQueryClient(createD1Facade(sqlite)),
			{ orgId: "org-a", now: "2026-08-21T04:00:00.000Z" },
		);

		expect(projection).toMatchObject({
			workItems: { total: 1, byDisposition: { accepted: 1 } },
			attempts: { total: 1, active: 1 },
			resources: {
				poolCount: 1,
				totalCapacity: 2,
			},
		});
		expect(projection.attention.actions).toEqual([]);
	});

	it("ranks only actionable pressure and does not double-count overdue interactions", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(DDL);
		sqlite.exec(`
			INSERT INTO work_items (id,org_id,disposition) VALUES ('item','org-a','accepted');
			INSERT INTO work_attempts (id,org_id,work_item_id,runtime_state,expires_at)
			VALUES ('stale','org-a','item','running','2026-08-21T03:00:00.000Z');
			INSERT INTO work_interactions (id,org_id,status,due_at,expires_at) VALUES
			('overdue','org-a','open','2026-08-21T03:00:00.000Z',NULL),
			('open','org-a','open','2026-08-21T05:00:00.000Z',NULL);
			INSERT INTO work_approval_proposals (id,org_id,status,expires_at)
			VALUES ('approval','org-a','pending','2026-08-21T05:00:00.000Z');
		`);

		const projection = await getWorkFleetProjection(
			createDbQueryClient(createD1Facade(sqlite)),
			{ orgId: "org-a", now: "2026-08-21T04:00:00.000Z" },
		);

		expect(
			projection.attention.actions.map(({ key, count }) => ({ key, count })),
		).toEqual([
			{ key: "stale_attempt_leases", count: 1 },
			{ key: "overdue_interactions", count: 1 },
			{ key: "approval_backlog", count: 1 },
			{ key: "interaction_backlog", count: 1 },
		]);
	});

	it("counts stale leases on terminal Work Items as census but not as attention", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(DDL);
		sqlite.exec(`
			INSERT INTO work_items (id,org_id,disposition) VALUES
			('accepted','org-a','accepted'),
			('completed','org-a','completed'),
			('cancelled','org-a','cancelled');
			INSERT INTO work_attempts (id,org_id,work_item_id,runtime_state,expires_at) VALUES
			('stale-accepted','org-a','accepted','running','2026-08-21T03:00:00.000Z'),
			('stale-completed','org-a','completed','running','2026-08-21T03:00:00.000Z'),
			('stale-cancelled','org-a','cancelled','waiting','2026-08-21T03:00:00.000Z');
		`);

		const projection = await getWorkFleetProjection(
			createDbQueryClient(createD1Facade(sqlite)),
			{ orgId: "org-a", now: "2026-08-21T04:00:00.000Z" },
		);

		expect(projection.attempts.staleLeases).toBe(3);
		expect(projection.attention.staleAttemptLeases).toBe(1);
		expect(
			projection.attention.actions.map(({ key, count }) => ({ key, count })),
		).toEqual([{ key: "stale_attempt_leases", count: 1 }]);
	});
});
