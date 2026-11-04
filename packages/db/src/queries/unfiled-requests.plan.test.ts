import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import { countUnfiledRequests, listUnfiledRequests } from "./request-filings";

const ORG = "org-example";
const OWNER = "ada";
const NOW = "2026-11-04T20:00:00.000Z";

function seed() {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	const insertRequest = sqlite.prepare(`INSERT INTO agent_session_requests
		(id, organization_id, user_id, harness, session_key, project_id, kind, text, status, source_at, source_key, status_changed_at, created_at, updated_at)
		VALUES (?, ?, ?, 'claude-code', 'session', ?, 'request', ?, ?, ?, ?, ?, ?, ?)`);
	// The owner's closed and filed history dwarfs the open queue.
	for (let i = 0; i < 3000; i++) {
		const at = `2026-10-${String(1 + (i % 28)).padStart(2, "0")}T10:00:${String(i % 60).padStart(2, "0")}.000Z`;
		insertRequest.run(
			`closed-${i}`,
			ORG,
			OWNER,
			i % 3 === 0 ? null : "project-a",
			`closed ${i}`,
			i % 3 === 0 ? "done" : i % 3 === 1 ? "cancelled" : "open",
			at,
			`closed-${i}`,
			at,
			at,
			at,
		);
	}
	for (const [id, org, owner, projectId, status, sourceAt] of [
		["open-new", ORG, OWNER, null, "open", "2026-11-03T10:00:00.000Z"],
		["open-old", ORG, OWNER, null, "in_progress", "2026-11-01T10:00:00.000Z"],
		[
			"waiting",
			ORG,
			OWNER,
			null,
			"waiting_on_user",
			"2026-11-02T10:00:00.000Z",
		],
		["proposed", ORG, OWNER, null, "open", "2026-11-02T12:00:00.000Z"],
		["reproposed", ORG, OWNER, null, "open", "2026-11-02T11:00:00.000Z"],
		["filed", ORG, OWNER, "project-a", "open", "2026-11-03T11:00:00.000Z"],
		["done", ORG, OWNER, null, "done", "2026-11-03T12:00:00.000Z"],
		["foreign-owner", ORG, "grace", null, "open", "2026-11-03T13:00:00.000Z"],
		[
			"foreign-tenant",
			"org-other",
			OWNER,
			null,
			"open",
			"2026-11-03T14:00:00.000Z",
		],
	] as const) {
		insertRequest.run(
			id,
			org,
			owner,
			projectId,
			id,
			status,
			sourceAt,
			id,
			sourceAt,
			sourceAt,
			NOW,
		);
	}
	const insertEvent = sqlite.prepare(`INSERT INTO learning_interaction_events
		(id, organization_id, actor_type, client_event_id, event_kind, scope_kind, scope_id, surface, issue_key, metadata, occurred_at, created_at)
		VALUES (?, ?, 'system', ?, 'edited', 'personal', ?, 'request_filing', ?, ?, ?, ?)`);
	// Many non-pending filing events for the owner, later than every row.
	for (let i = 0; i < 2000; i++) {
		insertEvent.run(
			`history-${i}`,
			ORG,
			`history-${i}`,
			OWNER,
			`request-filing:closed-${i}`,
			JSON.stringify({ ledgerOwnerId: OWNER, pending: false }),
			"2026-11-04T21:00:00.000Z",
			NOW,
		);
	}
	// A pending proposal after the row's last update hides it from the queue;
	// one from before the update does not.
	insertEvent.run(
		"pending-proposed",
		ORG,
		"pending-proposed",
		OWNER,
		"request-filing:proposed",
		JSON.stringify({ ledgerOwnerId: OWNER, pending: true }),
		"2026-11-04T21:00:00.000Z",
		NOW,
	);
	insertEvent.run(
		"pending-stale",
		ORG,
		"pending-stale",
		OWNER,
		"request-filing:reproposed",
		JSON.stringify({ ledgerOwnerId: OWNER, pending: true }),
		"2026-11-04T19:00:00.000Z",
		NOW,
	);
	insertEvent.run(
		"pending-other-owner",
		ORG,
		"pending-other-owner",
		"grace",
		"request-filing:open-new",
		JSON.stringify({ ledgerOwnerId: "grace", pending: true }),
		"2026-11-04T21:00:00.000Z",
		NOW,
	);
	const plans: string[] = [];
	const db = createDbQueryClient(
		createD1Facade({
			prepare(query) {
				plans.push(
					...sqlite
						.prepare(`EXPLAIN QUERY PLAN ${query}`)
						.all(...Array((query.match(/\?/g) ?? []).length).fill(null))
						.map((row) => String(row.detail)),
				);
				return sqlite.prepare(query);
			},
			exec: (query) => sqlite.exec(query),
		}),
	);
	return { sqlite, db, plans };
}

it("lists an owner's open unfiled requests from the partial index, newest first", async () => {
	const { sqlite, db, plans } = seed();
	const rows = await listUnfiledRequests(db, {
		organizationId: ORG,
		userId: OWNER,
	});
	expect(rows.map((row) => row.id)).toEqual([
		"open-new",
		"reproposed",
		"waiting",
		"open-old",
	]);
	expect(rows.every((row) => row.projectId === null)).toBe(true);
	expect(plans).toContainEqual(
		expect.stringMatching(
			/^SEARCH agent_session_requests USING INDEX idx_agent_session_requests_open_unfiled \(organization_id=\? AND user_id=\?\)/,
		),
	);
	expect(plans).toContainEqual(
		expect.stringMatching(
			/^SEARCH e USING INDEX idx_learning_event_pending_filing \(organization_id=\? AND issue_key=\? AND occurred_at>\?\)/,
		),
	);
	expect(
		plans.some((plan) =>
			/TEMP B-TREE|^SCAN |idx_learning_event_filing_owner_occurred/.test(plan),
		),
	).toBe(false);
	sqlite.close();
});

it("counts an owner's open unfiled requests from the partial index", async () => {
	const { sqlite, db, plans } = seed();
	await expect(
		countUnfiledRequests(db, { organizationId: ORG, userId: OWNER }),
	).resolves.toBe(5);
	expect(plans).toContainEqual(
		expect.stringMatching(
			/idx_agent_session_requests_open_unfiled \(organization_id=\? AND user_id=\?\)/,
		),
	);
	expect(plans.some((plan) => /TEMP B-TREE|^SCAN /.test(plan))).toBe(false);
	sqlite.close();
});
