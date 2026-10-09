/**
 * The stale-delegation sweep cancels kernel-delegation Work Items whose latest
 * Attempt failed and that nobody retried for a week. These tests pin the
 * candidate predicate (source, age, latest-attempt state, no active attempt),
 * the recorded reason, the bound, and idempotence.
 */

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import {
	STALE_FAILED_DELEGATION_REASON,
	sweepStaleFailedDelegationWorkItems,
} from "./stale-delegation-sweep";

const NOW = "2026-10-09T12:00:00.000Z";
const EIGHT_DAYS_AGO = "2026-10-01T12:00:00.000Z";
const TWO_DAYS_AGO = "2026-10-07T12:00:00.000Z";
const DELEGATION = JSON.stringify({ source: "kernelRuntime.directDelegation" });

const DDL = `
CREATE TABLE work_items (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
 disposition TEXT NOT NULL DEFAULT 'proposed', work_kind TEXT NOT NULL DEFAULT 'other', risk_level TEXT NOT NULL DEFAULT 'medium', acceptance_contract TEXT,
 required_capabilities TEXT NOT NULL DEFAULT '[]', required_authorities TEXT NOT NULL DEFAULT '[]', admission_spec_revision TEXT NOT NULL DEFAULT 'test-revision',
 priority TEXT NOT NULL DEFAULT 'medium', accountable_owner_type TEXT, accountable_owner_id TEXT, steward_type TEXT, steward_id TEXT, reviewer_type TEXT, reviewer_id TEXT, reviewer_lease_expires_at TEXT,
 objective_id TEXT, work_class TEXT, purpose_exception_expires_at TEXT, project_id TEXT, parent_work_item_id TEXT, source_session_key TEXT, source_intent_id TEXT, due_date TEXT, deadline TEXT, start_at TEXT, duration_days INTEGER,
 provenance TEXT DEFAULT '{}', metadata TEXT DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT, accepted_at TEXT, completed_at TEXT, cancelled_at TEXT, version INTEGER NOT NULL DEFAULT 1, UNIQUE (org_id, id)
);
CREATE TABLE work_attempts (
 id TEXT PRIMARY KEY, admission_id TEXT, work_item_id TEXT NOT NULL, org_id TEXT NOT NULL, executor_type TEXT NOT NULL,
 executor_id TEXT NOT NULL, executor_session_id TEXT, external_session_key TEXT, run_id TEXT, runtime_state TEXT NOT NULL,
 outcome TEXT, attempt_number INTEGER NOT NULL, started_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL,
 expires_at TEXT, finished_at TEXT, summary TEXT, version INTEGER NOT NULL DEFAULT 1, metadata TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE work_events (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, org_id TEXT NOT NULL,
 work_item_id TEXT NOT NULL, attempt_id TEXT, event_type TEXT NOT NULL, actor_type TEXT NOT NULL,
 actor_id TEXT NOT NULL, actor_session_id TEXT, payload TEXT NOT NULL DEFAULT '{}', occurred_at TEXT NOT NULL
);
`;

let sqlite: DatabaseSync;
let db: ReturnType<typeof createDbQueryClient>;

function seedItem(params: {
	id: string;
	org?: string;
	disposition?: string;
	provenance?: string;
	updatedAt?: string;
}) {
	sqlite
		.prepare(
			`INSERT INTO work_items (id,org_id,title,disposition,provenance,created_at,updated_at)
			 VALUES (?,?,?,?,?,?,?)`,
		)
		.run(
			params.id,
			params.org ?? "org-1",
			`Item ${params.id}`,
			params.disposition ?? "accepted",
			params.provenance ?? DELEGATION,
			EIGHT_DAYS_AGO,
			params.updatedAt ?? EIGHT_DAYS_AGO,
		);
}

function seedAttempt(params: {
	workItemId: string;
	org?: string;
	number?: number;
	state?: "failed" | "finished" | "running" | "queued";
	finishedAt?: string | null;
}) {
	const state = params.state ?? "failed";
	const terminal = state === "failed" || state === "finished";
	sqlite
		.prepare(
			`INSERT INTO work_attempts
			 (id,work_item_id,org_id,executor_type,executor_id,runtime_state,outcome,attempt_number,started_at,heartbeat_at,finished_at)
			 VALUES (?,?,?,'tedi','tedi-1',?,?,?,?,?,?)`,
		)
		.run(
			`${params.workItemId}-attempt-${params.number ?? 1}`,
			params.workItemId,
			params.org ?? "org-1",
			state,
			terminal ? (state === "failed" ? "failed" : "succeeded") : null,
			params.number ?? 1,
			EIGHT_DAYS_AGO,
			EIGHT_DAYS_AGO,
			terminal ? (params.finishedAt ?? EIGHT_DAYS_AGO) : null,
		);
}

function disposition(id: string) {
	return (
		sqlite
			.prepare(`SELECT disposition FROM work_items WHERE id = ?`)
			.get(id) as { disposition: string }
	).disposition;
}

beforeEach(() => {
	sqlite = new DatabaseSync(":memory:");
	sqlite.exec(DDL);
	db = createDbQueryClient(createD1Facade(sqlite));
});

describe("sweepStaleFailedDelegationWorkItems", () => {
	it("cancels an abandoned failed delegation with the recorded reason", async () => {
		seedItem({ id: "stale" });
		seedAttempt({ workItemId: "stale" });

		const result = await sweepStaleFailedDelegationWorkItems(db, { now: NOW });

		expect(result).toEqual({ observed: 1, cancelled: 1, skipped: 0 });
		expect(disposition("stale")).toBe("cancelled");
		const event = sqlite
			.prepare(
				`SELECT event_type, actor_type, actor_id, payload FROM work_events WHERE work_item_id = 'stale'`,
			)
			.get() as {
			event_type: string;
			actor_type: string;
			actor_id: string;
			payload: string;
		};
		expect(event.event_type).toBe("work.cancelled");
		expect(event.actor_type).toBe("system");
		expect(JSON.parse(event.payload)).toEqual({
			reason: STALE_FAILED_DELEGATION_REASON,
		});
	});

	it("is idempotent", async () => {
		seedItem({ id: "stale" });
		seedAttempt({ workItemId: "stale" });
		await sweepStaleFailedDelegationWorkItems(db, { now: NOW });

		const again = await sweepStaleFailedDelegationWorkItems(db, { now: NOW });

		expect(again).toEqual({ observed: 0, cancelled: 0, skipped: 0 });
		expect(
			sqlite.prepare(`SELECT COUNT(*) AS n FROM work_events`).get() as {
				n: number;
			},
		).toEqual({ n: 1 });
	});

	it("leaves items that are not stale failed kernel delegations alone", async () => {
		// Latest attempt failed only two days ago.
		seedItem({ id: "recent-failure" });
		seedAttempt({ workItemId: "recent-failure", finishedAt: TWO_DAYS_AGO });
		// Old failure, but the item itself was touched recently.
		seedItem({ id: "recently-touched", updatedAt: TWO_DAYS_AGO });
		seedAttempt({ workItemId: "recently-touched" });
		// Old failure superseded by a newer running attempt (a retry).
		seedItem({ id: "retried-running" });
		seedAttempt({ workItemId: "retried-running", number: 1 });
		seedAttempt({ workItemId: "retried-running", number: 2, state: "running" });
		// Old failure superseded by a queued attempt.
		seedItem({ id: "retried-queued" });
		seedAttempt({ workItemId: "retried-queued", number: 1 });
		seedAttempt({ workItemId: "retried-queued", number: 2, state: "queued" });
		// Latest attempt succeeded; an earlier one failed.
		seedItem({ id: "later-success" });
		seedAttempt({ workItemId: "later-success", number: 1 });
		seedAttempt({ workItemId: "later-success", number: 2, state: "finished" });
		// Same shape but not a kernel delegation.
		seedItem({ id: "manual", provenance: JSON.stringify({ source: "cli" }) });
		seedAttempt({ workItemId: "manual" });
		// Never attempted.
		seedItem({ id: "no-attempts" });
		// Already terminal.
		seedItem({ id: "done", disposition: "completed" });
		seedAttempt({ workItemId: "done" });

		const result = await sweepStaleFailedDelegationWorkItems(db, { now: NOW });

		expect(result).toEqual({ observed: 0, cancelled: 0, skipped: 0 });
		for (const id of [
			"recent-failure",
			"recently-touched",
			"retried-running",
			"retried-queued",
			"later-success",
			"manual",
			"no-attempts",
		]) {
			expect(disposition(id)).toBe("accepted");
		}
		expect(disposition("done")).toBe("completed");
	});

	it("cancels each item within its own org and bounds a pass by limit", async () => {
		seedItem({ id: "a", org: "org-1" });
		seedAttempt({ workItemId: "a", org: "org-1" });
		seedItem({ id: "b", org: "org-2" });
		seedAttempt({ workItemId: "b", org: "org-2" });
		seedItem({ id: "c", org: "org-2" });
		seedAttempt({ workItemId: "c", org: "org-2" });

		const first = await sweepStaleFailedDelegationWorkItems(db, {
			now: NOW,
			limit: 2,
		});
		expect(first).toEqual({ observed: 2, cancelled: 2, skipped: 0 });
		const second = await sweepStaleFailedDelegationWorkItems(db, {
			now: NOW,
			limit: 2,
		});
		expect(second).toEqual({ observed: 1, cancelled: 1, skipped: 0 });

		const events = sqlite
			.prepare(
				`SELECT org_id, work_item_id FROM work_events ORDER BY org_id, work_item_id`,
			)
			.all() as Array<{ org_id: string; work_item_id: string }>;
		expect(events).toEqual([
			{ org_id: "org-1", work_item_id: "a" },
			{ org_id: "org-2", work_item_id: "b" },
			{ org_id: "org-2", work_item_id: "c" },
		]);
	});
});
