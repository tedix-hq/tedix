/**
 * A budget reservation settles to the spend actually committed against it.
 *
 * An Attempt that expires or is cancelled without committing any spend gives
 * its reservation back; one that reported spend consumes exactly that. The
 * old rule consumed the full reserved amount on expiry, so one dead lease on a
 * `limit == reservation` envelope made the Work Item permanently inadmissible:
 * committed (full) + a new reservation always exceeded the limit.
 *
 * `replaceWorkAdmissionSpecification` is pinned here too: a specification
 * naming a resource key with no enabled pool is a typed rejection carrying the
 * missing keys, not a batch failure.
 */

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import {
	replaceWorkAdmissionSpecification,
	WorkAdmissionSpecificationError,
} from "./admissions";
import {
	heartbeatWorkItemAttempt,
	settleWorkItemAttempt,
	startWorkItemAttempt,
	sweepElapsedWorkAttempts,
} from "./attempts";
import { listWorkBudgetEnvelopes } from "./budgets";

const ORG = "org-1";
const ITEM = "work-1";
const PAST = "2026-09-29T10:00:00.000Z";
const LEASE_END = "2026-09-29T11:00:00.000Z";
const NOW = "2026-09-29T12:00:00.000Z";
const LIMIT = 25_000_000;

const DDL = `
CREATE TABLE work_items (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
 disposition TEXT NOT NULL DEFAULT 'accepted', work_kind TEXT NOT NULL DEFAULT 'other', risk_level TEXT NOT NULL DEFAULT 'medium', acceptance_contract TEXT,
 required_capabilities TEXT NOT NULL DEFAULT '[]', required_authorities TEXT NOT NULL DEFAULT '[]', admission_spec_revision TEXT NOT NULL DEFAULT 'rev-1',
 priority TEXT NOT NULL DEFAULT 'medium', accountable_owner_type TEXT, accountable_owner_id TEXT, steward_type TEXT, steward_id TEXT, reviewer_type TEXT, reviewer_id TEXT, reviewer_lease_expires_at TEXT,
 objective_id TEXT, work_class TEXT, purpose_exception_expires_at TEXT, project_id TEXT, parent_work_item_id TEXT, source_session_key TEXT, source_intent_id TEXT, due_date TEXT, deadline TEXT, start_at TEXT, duration_days INTEGER,
 provenance TEXT DEFAULT '{}', metadata TEXT DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT, accepted_at TEXT, completed_at TEXT, cancelled_at TEXT, version INTEGER NOT NULL DEFAULT 1, UNIQUE (org_id, id)
);
CREATE TABLE work_attempts (
 id TEXT PRIMARY KEY, admission_id TEXT, work_item_id TEXT NOT NULL, org_id TEXT NOT NULL,
 executor_type TEXT NOT NULL, executor_id TEXT NOT NULL, executor_session_id TEXT,
 external_session_key TEXT, run_id TEXT, runtime_state TEXT NOT NULL DEFAULT 'running',
 outcome TEXT, attempt_number INTEGER NOT NULL, started_at TEXT NOT NULL,
 heartbeat_at TEXT NOT NULL, expires_at TEXT, finished_at TEXT, summary TEXT,
 version INTEGER NOT NULL DEFAULT 1, metadata TEXT NOT NULL DEFAULT '{}',
 CONSTRAINT chk_work_attempt_terminal_state CHECK (
  (runtime_state IN ('failed','expired','finished','cancelled') AND finished_at IS NOT NULL AND outcome IS NOT NULL)
  OR (runtime_state IN ('queued','running','waiting','retrying') AND finished_at IS NULL AND outcome IS NULL))
);
CREATE UNIQUE INDEX uniq_work_attempt_active ON work_attempts (org_id, work_item_id)
 WHERE runtime_state IN ('queued','running','waiting','retrying');
CREATE TABLE work_admissions (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, work_item_id TEXT NOT NULL, work_item_version INTEGER NOT NULL,
 admission_spec_revision TEXT NOT NULL, executor_type TEXT NOT NULL, executor_id TEXT NOT NULL,
 executor_session_id TEXT, external_session_key TEXT, decision TEXT NOT NULL, rejection_code TEXT,
 rejection_reason TEXT, rejection_key TEXT, max_cost_micros INTEGER, decided_at TEXT NOT NULL,
 expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE work_resource_pools (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, resource_key TEXT NOT NULL, allocation_mode TEXT NOT NULL,
 capacity INTEGER NOT NULL, owner_ref TEXT, enabled INTEGER NOT NULL DEFAULT 1, metadata TEXT NOT NULL DEFAULT '{}',
 created_at TEXT NOT NULL, updated_at TEXT, version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE work_resource_requirements (
 org_id TEXT NOT NULL, work_item_id TEXT NOT NULL, resource_key TEXT NOT NULL, quantity INTEGER NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(org_id,work_item_id,resource_key)
);
CREATE TABLE work_resource_reservations (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, admission_id TEXT NOT NULL, work_item_id TEXT NOT NULL,
 pool_id TEXT NOT NULL, pool_version INTEGER NOT NULL, resource_key TEXT NOT NULL,
 quantity INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'active', reserved_at TEXT NOT NULL,
 expires_at TEXT NOT NULL, settled_at TEXT, version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE work_budget_envelopes (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, scope_type TEXT NOT NULL, scope_id TEXT NOT NULL,
 limit_micros INTEGER NOT NULL, reservation_micros INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'USD',
 enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT, version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE work_budget_reservations (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, admission_id TEXT NOT NULL, work_item_id TEXT NOT NULL,
 envelope_id TEXT NOT NULL, envelope_version INTEGER NOT NULL, amount_micros INTEGER NOT NULL,
 consumed_micros INTEGER, state TEXT NOT NULL DEFAULT 'active', reserved_at TEXT NOT NULL,
 expires_at TEXT NOT NULL, settled_at TEXT, version INTEGER NOT NULL DEFAULT 1,
 CHECK (state <> 'consumed' OR (consumed_micros IS NOT NULL AND consumed_micros >= 0 AND consumed_micros <= amount_micros))
);
CREATE TABLE work_events (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, org_id TEXT NOT NULL,
 work_item_id TEXT NOT NULL, attempt_id TEXT, event_type TEXT NOT NULL, actor_type TEXT NOT NULL,
 actor_id TEXT NOT NULL, actor_session_id TEXT, payload TEXT NOT NULL DEFAULT '{}',
 occurred_at TEXT NOT NULL
);
`;

let sqlite: DatabaseSync;
let db: ReturnType<typeof createDbQueryClient>;

function seedItemWithEnvelope() {
	sqlite
		.prepare(
			`INSERT INTO work_items (id,org_id,title,accountable_owner_type,accountable_owner_id,created_at,accepted_at)
			 VALUES (?,?,'item','system','test',?,?)`,
		)
		.run(ITEM, ORG, PAST, PAST);
	sqlite
		.prepare(
			`INSERT INTO work_budget_envelopes (id,org_id,scope_type,scope_id,limit_micros,reservation_micros,created_at)
			 VALUES ('env-1',?,'work_item',?,?,?,?)`,
		)
		.run(ORG, ITEM, LIMIT, LIMIT, PAST);
}

function seedAdmission(id: string, expiresAt: string) {
	sqlite
		.prepare(
			`INSERT INTO work_admissions (id,org_id,work_item_id,work_item_version,admission_spec_revision,executor_type,executor_id,decision,decided_at,expires_at,created_at)
			 VALUES (?,?,?,1,'rev-1','tedi','worker','admitted',?,?,?)`,
		)
		.run(id, ORG, ITEM, PAST, expiresAt, PAST);
	sqlite
		.prepare(
			`INSERT INTO work_budget_reservations (id,org_id,admission_id,work_item_id,envelope_id,envelope_version,amount_micros,state,reserved_at,expires_at)
			 VALUES (?,?,?,?,'env-1',1,?,'active',?,?)`,
		)
		.run(`bud-${id}`, ORG, id, ITEM, LIMIT, PAST, expiresAt);
	sqlite
		.prepare(
			`INSERT INTO work_resource_reservations (id,org_id,admission_id,work_item_id,pool_id,pool_version,resource_key,quantity,state,reserved_at,expires_at)
			 VALUES (?,?,?,?,'pool-1',1,'runner',1,'active',?,?)`,
		)
		.run(`res-${id}`, ORG, id, ITEM, PAST, expiresAt);
}

async function startAttempt(admissionId: string, startedAt: string) {
	const admission = sqlite
		.prepare(`SELECT expires_at FROM work_admissions WHERE id = ?`)
		.get(admissionId) as { expires_at: string };
	return startWorkItemAttempt(db, {
		orgId: ORG,
		workItemId: ITEM,
		admissionId,
		executor: { type: "tedi", id: "worker" },
		expiresAt: admission.expires_at,
		startedAt,
	});
}

function budgetRow(admissionId: string) {
	return sqlite
		.prepare(
			`SELECT state, consumed_micros, settled_at FROM work_budget_reservations WHERE admission_id = ?`,
		)
		.get(admissionId) as {
		state: string;
		consumed_micros: number | null;
		settled_at: string | null;
	};
}

async function envelope() {
	const page = await listWorkBudgetEnvelopes(db, {
		orgId: ORG,
		scopeType: "work_item",
		scopeId: ITEM,
		at: NOW,
	});
	return page.data[0]!;
}

beforeEach(() => {
	sqlite = new DatabaseSync(":memory:");
	sqlite.exec(DDL);
	db = createDbQueryClient(createD1Facade(sqlite));
	seedItemWithEnvelope();
});

describe("budget reservation settlement", () => {
	it("releases the reservation when the lease expires with nothing committed, restoring the budget", async () => {
		seedAdmission("adm-1", LEASE_END);
		await startAttempt("adm-1", PAST);
		expect((await envelope()).committedMicros).toBe(0); // lease already elapsed at NOW

		const swept = await sweepElapsedWorkAttempts(db, { now: NOW });
		expect(swept.expired).toBe(1);
		expect(budgetRow("adm-1")).toEqual({
			state: "released",
			consumed_micros: null,
			settled_at: NOW,
		});
		const after = await envelope();
		expect(after.committedMicros).toBe(0);
		expect(after.committedMicros + after.reservationMicros).toBeLessThanOrEqual(
			after.limitMicros,
		);
	});

	it("consumes only the committed spend when an attempt with reported cost expires", async () => {
		seedAdmission("adm-1", LEASE_END);
		const { attempt } = await startAttempt("adm-1", PAST);
		await heartbeatWorkItemAttempt(db, {
			orgId: ORG,
			workItemId: ITEM,
			attemptId: attempt.id,
			executor: { type: "tedi", id: "worker" },
			heartbeatAt: "2026-09-29T10:30:00.000Z",
			leaseTtlMs: 30 * 60_000,
			costMicros: 1_200_000,
		});
		await sweepElapsedWorkAttempts(db, { now: NOW });
		expect(budgetRow("adm-1")).toEqual({
			state: "consumed",
			consumed_micros: 1_200_000,
			settled_at: NOW,
		});
		expect((await envelope()).committedMicros).toBe(1_200_000);
	});

	it("applies the same rule when the next admission reaps the dead lease", async () => {
		seedAdmission("adm-1", LEASE_END);
		await startAttempt("adm-1", PAST);
		seedAdmission("adm-2", "2026-09-29T13:00:00.000Z");
		const second = await startAttempt("adm-2", NOW);
		expect(second.attempt.attemptNumber).toBe(2);
		expect(budgetRow("adm-1").state).toBe("released");
		expect(budgetRow("adm-2").state).toBe("active");
	});

	it("releases on cancel with no spend and consumes exactly the settled cost otherwise", async () => {
		seedAdmission("adm-1", "2026-09-29T13:00:00.000Z");
		const { attempt } = await startAttempt("adm-1", PAST);
		await settleWorkItemAttempt(db, {
			orgId: ORG,
			workItemId: ITEM,
			attemptId: attempt.id,
			executor: { type: "tedi", id: "worker" },
			outcome: "cancelled",
			settledAt: NOW,
		});
		expect(budgetRow("adm-1")).toMatchObject({
			state: "released",
			consumed_micros: null,
		});

		seedAdmission("adm-2", "2026-09-29T14:00:00.000Z");
		const next = await startAttempt("adm-2", "2026-09-29T12:30:00.000Z");
		await settleWorkItemAttempt(db, {
			orgId: ORG,
			workItemId: ITEM,
			attemptId: next.attempt.id,
			executor: { type: "tedi", id: "worker" },
			outcome: "cancelled",
			costMicros: 400_000,
			settledAt: "2026-09-29T12:45:00.000Z",
		});
		expect(budgetRow("adm-2")).toMatchObject({
			state: "consumed",
			consumed_micros: 400_000,
		});
	});

	it("caps consumption at the reserved amount, as the production trigger requires", async () => {
		seedAdmission("adm-1", "2026-09-29T13:00:00.000Z");
		const { attempt } = await startAttempt("adm-1", PAST);
		await settleWorkItemAttempt(db, {
			orgId: ORG,
			workItemId: ITEM,
			attemptId: attempt.id,
			executor: { type: "tedi", id: "worker" },
			outcome: "failed",
			costMicros: LIMIT * 3,
			settledAt: NOW,
		});
		expect(budgetRow("adm-1")).toMatchObject({
			state: "consumed",
			consumed_micros: LIMIT,
		});
	});

	it("still charges a finished attempt its full reservation when no cost was ever reported", async () => {
		seedAdmission("adm-1", "2026-09-29T13:00:00.000Z");
		const { attempt } = await startAttempt("adm-1", PAST);
		await settleWorkItemAttempt(db, {
			orgId: ORG,
			workItemId: ITEM,
			attemptId: attempt.id,
			executor: { type: "tedi", id: "worker" },
			outcome: "succeeded",
			settledAt: NOW,
		});
		expect(budgetRow("adm-1")).toMatchObject({
			state: "consumed",
			consumed_micros: LIMIT,
		});
	});
});

describe("replaceWorkAdmissionSpecification pool registration", () => {
	const spec = (keys: string[]) => ({
		orgId: ORG,
		workItemId: ITEM,
		expectedWorkItemVersion: 1,
		expectedAdmissionSpecRevision: "rev-1",
		specification: {
			resources: keys.map((resourceKey) => ({ resourceKey, quantity: 1 })),
			budget: null,
		},
		now: NOW,
	});

	it("rejects unregistered resource keys by name before touching the specification", async () => {
		sqlite
			.prepare(
				`INSERT INTO work_resource_pools (id,org_id,resource_key,allocation_mode,capacity,created_at) VALUES ('pool-1',?,'file:repo:a.ts','exclusive',1,?)`,
			)
			.run(ORG, PAST);
		const attempt = replaceWorkAdmissionSpecification(
			db,
			spec(["file:repo:a.ts", "file:repo:missing.ts", "feature:repo:x"]),
		);
		await expect(attempt).rejects.toBeInstanceOf(
			WorkAdmissionSpecificationError,
		);
		await expect(attempt).rejects.toMatchObject({
			code: "NOT_ELIGIBLE",
			missingResourceKeys: ["file:repo:missing.ts", "feature:repo:x"],
		});
		expect(
			sqlite
				.prepare(
					`SELECT version, admission_spec_revision FROM work_items WHERE id=?`,
				)
				.get(ITEM),
		).toEqual({ version: 1, admission_spec_revision: "rev-1" });
	});

	it("treats a disabled pool as unregistered", async () => {
		sqlite
			.prepare(
				`INSERT INTO work_resource_pools (id,org_id,resource_key,allocation_mode,capacity,enabled,created_at) VALUES ('pool-1',?,'file:repo:a.ts','exclusive',1,0,?)`,
			)
			.run(ORG, PAST);
		await expect(
			replaceWorkAdmissionSpecification(db, spec(["file:repo:a.ts"])),
		).rejects.toMatchObject({ missingResourceKeys: ["file:repo:a.ts"] });
	});

	it("accepts a specification whose keys all have enabled pools", async () => {
		sqlite
			.prepare(
				`INSERT INTO work_resource_pools (id,org_id,resource_key,allocation_mode,capacity,created_at) VALUES ('pool-1',?,'file:repo:a.ts','exclusive',1,?)`,
			)
			.run(ORG, PAST);
		const receipt = await replaceWorkAdmissionSpecification(
			db,
			spec(["file:repo:a.ts"]),
		);
		expect(receipt.resources).toEqual([
			{ resourceKey: "file:repo:a.ts", quantity: 1 },
		]);
		expect(receipt.workItemVersion).toBe(2);
	});
});
