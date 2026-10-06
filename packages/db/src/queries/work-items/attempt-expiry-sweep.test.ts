/**
 * The expiry sweeper retires an elapsed Attempt lease WITHOUT a fresh admission.
 *
 * The admission path only reaps a dead lease as a side effect of the next
 * `work start`, so an item that cannot be admitted at all — an expired
 * operational purpose exception is the live case — strands its Attempt, its
 * capacity reservation and its budget reservation forever. These tests pin the
 * boundary condition, the terminal-state contract, reservation retirement,
 * idempotence, and the audit event.
 */

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { sweepElapsedWorkAttempts } from "./attempts";

const ORG = "org-1";
const NOW = "2026-08-25T12:00:00.000Z";
const PAST = "2026-08-25T11:00:00.000Z";
const FUTURE = "2026-08-25T13:00:00.000Z";

/**
 * `chk_work_attempt_terminal_state` is reproduced verbatim: a sweep that set
 * only some of `runtime_state`, `outcome`, `finished_at` must fail here exactly
 * as it fails on D1.
 */
const DDL = `
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
CREATE TABLE work_resource_reservations (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, admission_id TEXT NOT NULL, work_item_id TEXT NOT NULL,
 pool_id TEXT NOT NULL, pool_version INTEGER NOT NULL, resource_key TEXT NOT NULL,
 quantity INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'active', reserved_at TEXT NOT NULL,
 expires_at TEXT NOT NULL, settled_at TEXT, version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE work_budget_reservations (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, admission_id TEXT NOT NULL, work_item_id TEXT NOT NULL,
 envelope_id TEXT NOT NULL, envelope_version INTEGER NOT NULL, amount_micros INTEGER NOT NULL,
 consumed_micros INTEGER, state TEXT NOT NULL DEFAULT 'active', reserved_at TEXT NOT NULL,
 expires_at TEXT NOT NULL, settled_at TEXT, version INTEGER NOT NULL DEFAULT 1
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

function seedAttempt(params: {
	id: string;
	workItemId: string;
	expiresAt: string | null;
	runtimeState?: string;
	admissionId?: string;
}) {
	const terminal = ["failed", "expired", "finished", "cancelled"].includes(
		params.runtimeState ?? "running",
	);
	sqlite
		.prepare(
			`INSERT INTO work_attempts
			 (id,admission_id,work_item_id,org_id,executor_type,executor_id,executor_session_id,
			  external_session_key,runtime_state,outcome,attempt_number,started_at,heartbeat_at,
			  expires_at,finished_at)
			 VALUES (?,?,?,?,'external_agent','agent-1','session-1','key-1',?,?,1,?,?,?,?)`,
		)
		.run(
			params.id,
			params.admissionId ?? `admission-${params.id}`,
			params.workItemId,
			ORG,
			params.runtimeState ?? "running",
			terminal ? "expired" : null,
			PAST,
			PAST,
			params.expiresAt,
			terminal ? PAST : null,
		);
}

function seedReservations(params: {
	admissionId: string;
	workItemId: string;
	expiresAt: string;
}) {
	sqlite
		.prepare(
			`INSERT INTO work_resource_reservations
			 (id,org_id,admission_id,work_item_id,pool_id,pool_version,resource_key,quantity,state,reserved_at,expires_at)
			 VALUES (?,?,?,?,'pool-1',1,'runner',1,'active',?,?)`,
		)
		.run(
			`res-${params.admissionId}`,
			ORG,
			params.admissionId,
			params.workItemId,
			PAST,
			params.expiresAt,
		);
	sqlite
		.prepare(
			`INSERT INTO work_budget_reservations
			 (id,org_id,admission_id,work_item_id,envelope_id,envelope_version,amount_micros,state,reserved_at,expires_at)
			 VALUES (?,?,?,?,'envelope-1',1,5000,'active',?,?)`,
		)
		.run(
			`bud-${params.admissionId}`,
			ORG,
			params.admissionId,
			params.workItemId,
			PAST,
			params.expiresAt,
		);
}

function attemptRow(id: string) {
	return sqlite
		.prepare(
			`SELECT runtime_state, outcome, finished_at, version FROM work_attempts WHERE id = ?`,
		)
		.get(id) as
		| {
				runtime_state: string;
				outcome: string | null;
				finished_at: string | null;
				version: number;
		  }
		| undefined;
}

function reservationStates(admissionId: string) {
	return {
		resource: sqlite
			.prepare(
				`SELECT state, settled_at FROM work_resource_reservations WHERE admission_id = ?`,
			)
			.get(admissionId) as { state: string; settled_at: string | null },
		budget: sqlite
			.prepare(
				`SELECT state, consumed_micros, settled_at FROM work_budget_reservations WHERE admission_id = ?`,
			)
			.get(admissionId) as {
			state: string;
			consumed_micros: number | null;
			settled_at: string | null;
		},
	};
}

function events() {
	return sqlite
		.prepare(
			`SELECT event_type, attempt_id, actor_type, actor_id, payload FROM work_events ORDER BY sequence`,
		)
		.all() as Array<{
		event_type: string;
		attempt_id: string | null;
		actor_type: string;
		actor_id: string;
		payload: string;
	}>;
}

beforeEach(() => {
	sqlite = new DatabaseSync(":memory:");
	sqlite.exec(DDL);
	db = createDbQueryClient(createD1Facade(sqlite));
});

describe("sweepElapsedWorkAttempts", () => {
	it("retires an elapsed attempt with all three terminal fields together", async () => {
		seedAttempt({ id: "a-1", workItemId: "w-1", expiresAt: PAST });
		const result = await sweepElapsedWorkAttempts(db, { now: NOW });
		expect(result).toEqual({ observed: 1, expired: 1, skipped: 0 });
		expect(attemptRow("a-1")).toMatchObject({
			runtime_state: "expired",
			outcome: "expired",
			finished_at: NOW,
			version: 2,
		});
	});

	it("frees the unique active slot, so the item is claimable again", async () => {
		seedAttempt({ id: "a-1", workItemId: "w-1", expiresAt: PAST });
		await sweepElapsedWorkAttempts(db, { now: NOW });
		expect(() =>
			seedAttempt({ id: "a-2", workItemId: "w-1", expiresAt: FUTURE }),
		).not.toThrow();
	});

	it("never disturbs a live lease, including one expiring in the future", async () => {
		seedAttempt({ id: "live", workItemId: "w-live", expiresAt: FUTURE });
		const result = await sweepElapsedWorkAttempts(db, { now: NOW });
		expect(result).toEqual({ observed: 0, expired: 0, skipped: 0 });
		expect(attemptRow("live")).toMatchObject({
			runtime_state: "running",
			outcome: null,
			finished_at: null,
			version: 1,
		});
	});

	it("never touches a lease with no expiry at all", async () => {
		seedAttempt({ id: "no-lease", workItemId: "w-null", expiresAt: null });
		expect(await sweepElapsedWorkAttempts(db, { now: NOW })).toEqual({
			observed: 0,
			expired: 0,
			skipped: 0,
		});
		expect(attemptRow("no-lease")?.runtime_state).toBe("running");
	});

	it("treats a lease expiring on the instant as elapsed, matching the authority read", async () => {
		// getAuthoritativeWorkItemAttempt requires expires_at > now, so a lease at
		// exactly `now` is already non-authoritative and must be sweepable. The two
		// boundaries are complements: no attempt is both live and sweepable, none
		// is neither.
		seedAttempt({ id: "boundary", workItemId: "w-b", expiresAt: NOW });
		expect(await sweepElapsedWorkAttempts(db, { now: NOW })).toMatchObject({
			expired: 1,
		});
		expect(attemptRow("boundary")?.runtime_state).toBe("expired");
	});

	it("retires reservations under the same policy the admission path uses", async () => {
		seedAttempt({
			id: "a-1",
			workItemId: "w-1",
			expiresAt: PAST,
			admissionId: "adm-1",
		});
		seedReservations({
			admissionId: "adm-1",
			workItemId: "w-1",
			expiresAt: PAST,
		});
		await sweepElapsedWorkAttempts(db, { now: NOW });
		const settled = reservationStates("adm-1");
		expect(settled.resource).toMatchObject({
			state: "expired",
			settled_at: NOW,
		});
		// Nothing was committed against the reservation, so it goes back to the
		// envelope instead of being charged at its full reserved amount.
		expect(settled.budget).toMatchObject({
			state: "released",
			consumed_micros: null,
			settled_at: NOW,
		});
	});

	it("consumes only the spend committed before the lease elapsed", async () => {
		seedAttempt({
			id: "a-1",
			workItemId: "w-1",
			expiresAt: PAST,
			admissionId: "adm-1",
		});
		seedReservations({
			admissionId: "adm-1",
			workItemId: "w-1",
			expiresAt: PAST,
		});
		sqlite
			.prepare(
				`UPDATE work_budget_reservations SET consumed_micros = 1200 WHERE admission_id = 'adm-1'`,
			)
			.run();
		await sweepElapsedWorkAttempts(db, { now: NOW });
		expect(reservationStates("adm-1").budget).toMatchObject({
			state: "consumed",
			consumed_micros: 1200,
			settled_at: NOW,
		});
	});

	it("leaves another item's live reservations alone", async () => {
		seedAttempt({
			id: "a-1",
			workItemId: "w-1",
			expiresAt: PAST,
			admissionId: "adm-1",
		});
		seedReservations({
			admissionId: "adm-1",
			workItemId: "w-1",
			expiresAt: PAST,
		});
		seedAttempt({
			id: "a-live",
			workItemId: "w-2",
			expiresAt: FUTURE,
			admissionId: "adm-2",
		});
		seedReservations({
			admissionId: "adm-2",
			workItemId: "w-2",
			expiresAt: FUTURE,
		});
		await sweepElapsedWorkAttempts(db, { now: NOW });
		expect(reservationStates("adm-2").resource.state).toBe("active");
		expect(reservationStates("adm-2").budget.state).toBe("active");
	});

	it("emits one attempt.expired event carrying the attempt's own executor", async () => {
		seedAttempt({ id: "a-1", workItemId: "w-1", expiresAt: PAST });
		await sweepElapsedWorkAttempts(db, { now: NOW });
		const emitted = events();
		expect(emitted).toHaveLength(1);
		expect(emitted[0]).toMatchObject({
			event_type: "attempt.expired",
			attempt_id: "a-1",
			actor_type: "external_agent",
			actor_id: "agent-1",
		});
		expect(JSON.parse(emitted[0]!.payload)).toEqual({
			outcome: "expired",
			reason: "lease_elapsed",
			expiresAt: PAST,
			reapedBy: "sweeper",
		});
	});

	it("changes nothing on a second pass", async () => {
		seedAttempt({
			id: "a-1",
			workItemId: "w-1",
			expiresAt: PAST,
			admissionId: "adm-1",
		});
		seedReservations({
			admissionId: "adm-1",
			workItemId: "w-1",
			expiresAt: PAST,
		});
		await sweepElapsedWorkAttempts(db, { now: NOW });
		const afterFirst = {
			attempt: attemptRow("a-1"),
			reservations: reservationStates("adm-1"),
			events: events(),
		};
		expect(await sweepElapsedWorkAttempts(db, { now: FUTURE })).toEqual({
			observed: 0,
			expired: 0,
			skipped: 0,
		});
		expect({
			attempt: attemptRow("a-1"),
			reservations: reservationStates("adm-1"),
			events: events(),
		}).toEqual(afterFirst);
	});

	it("ignores an attempt that is already terminal", async () => {
		seedAttempt({
			id: "done",
			workItemId: "w-1",
			expiresAt: PAST,
			runtimeState: "finished",
		});
		expect(await sweepElapsedWorkAttempts(db, { now: NOW })).toEqual({
			observed: 0,
			expired: 0,
			skipped: 0,
		});
		expect(attemptRow("done")).toMatchObject({
			runtime_state: "finished",
			version: 1,
		});
	});

	it("reports a concurrent winner as skipped rather than expiring twice", async () => {
		seedAttempt({ id: "a-1", workItemId: "w-1", expiresAt: PAST });
		// Land the competing retirement inside the sweep's read-modify-write
		// window, which is the only way to exercise the CAS guard's losing branch.
		let raced = false;
		const racing = createDbQueryClient(
			createD1Facade(sqlite, {
				onPrepare: (query) => {
					if (!raced && /^\s*update\s+"work_attempts"/i.test(query)) {
						raced = true;
						sqlite.exec(
							`UPDATE work_attempts SET runtime_state='expired', outcome='expired', finished_at='${PAST}', version=version+1 WHERE id='a-1'`,
						);
					}
				},
			}),
		);
		expect(await sweepElapsedWorkAttempts(racing, { now: NOW })).toEqual({
			observed: 1,
			expired: 0,
			skipped: 1,
		});
		expect(attemptRow("a-1")).toMatchObject({
			finished_at: PAST,
			version: 2,
		});
		expect(events()).toHaveLength(0);
	});

	it("bounds a pass and drains across repeated passes", async () => {
		for (let index = 0; index < 5; index += 1) {
			seedAttempt({
				id: `a-${index}`,
				workItemId: `w-${index}`,
				expiresAt: PAST,
			});
		}
		expect(await sweepElapsedWorkAttempts(db, { now: NOW, limit: 2 })).toEqual({
			observed: 2,
			expired: 2,
			skipped: 0,
		});
		expect(await sweepElapsedWorkAttempts(db, { now: NOW, limit: 10 })).toEqual(
			{
				observed: 3,
				expired: 3,
				skipped: 0,
			},
		);
	});
});
