import type { DatabaseSync } from "node:sqlite";
import { STALE_OWNER_TOOL_RUN_MS } from "@tedix/api-contract/utils/owner-tool-execution";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import {
	expireStaleApprovals,
	findPendingOwnerToolApproval,
	listApprovalRequests,
	listDueOwnerToolApprovals,
	requeueStaleContinuableOwnerToolApprovals,
} from "./approvals";
import { countPendingApprovalsByTedi } from "./governance-overview";

const PENDING = "idx_approval_requests_pending_expiry";
const RUNS = "idx_approval_requests_open_execution";
const ORG = "org-example";
const OTHER_ORG = "org-other";
const ENDPOINT = "example.purge";
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/** The three sweeps as they were before they stated an index condition. */
const LEGACY_EXPIRE = `SELECT id FROM tedi_approval_requests
	WHERE status = ?1 AND expires_at < ?2`;
const LEGACY_EXPIRE_ORG = `${LEGACY_EXPIRE} AND org_id = ?3`;
const LEGACY_DUE = `SELECT id FROM tedi_approval_requests
	WHERE action_type = ?1 AND status = ?2
		AND json_extract(payload, '$.kind') = 'mcp_tool_call'
		AND (json_extract(payload, '$.execution.status') = 'queued' OR (json_extract(payload, '$.execution.status') = 'running' AND json_extract(payload, '$.execution.startedAt') < ?3))
		AND json_extract(payload, '$.execution.nextAttemptAt') <= ?4
		AND json_extract(payload, '$.consumedAt') IS NULL
		AND json_extract(payload, '$.execution.dismissedAt') IS NULL
	ORDER BY json_extract(payload, '$.execution.nextAttemptAt'), id LIMIT ?5`;
const LEGACY_REQUEUE = `SELECT id FROM tedi_approval_requests
	WHERE action_type = ?1 AND status = ?2 AND expires_at > ?3
		AND json_extract(payload, '$.kind') = 'mcp_tool_call'
		AND json_extract(payload, '$.target.transport') = 'rpc'
		AND json_extract(payload, '$.target.endpoint') IN (?4)
		AND json_extract(payload, '$.args.dryRun') = 0
		AND ((json_extract(payload, '$.execution.status') = 'running'
				AND json_extract(payload, '$.execution.startedAt') < ?5)
			OR (json_extract(payload, '$.execution.status') = 'failed'
				AND coalesce(json_extract(payload, '$.transientRetries'), 0) < ?6
				AND (instr(json_extract(payload, '$.execution.error'), 'SERVICE_UNAVAILABLE') > 0
					OR instr(json_extract(payload, '$.execution.error'), 'timed out') > 0)))
		AND json_extract(payload, '$.execution.dismissedAt') IS NULL`;

type Statistics =
	| "none"
	| "production-sized"
	| "analysed before the indexes"
	| "analysed";

function fixture(statistics: Statistics, withIndexes = true) {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	const now = Date.now();
	const at = (ago: number) => new Date(now - ago).toISOString();
	const insert = sqlite.prepare(
		"INSERT INTO tedi_approval_requests (id, tedi_id, org_id, action_type, description, payload, status, created_at, expires_at, resolved_at) VALUES (?, ?, ?, ?, 'Example', ?, ?, ?, ?, ?)",
	);
	let sequence = 0;
	const add = (
		id: string,
		row: {
			org?: string;
			actionType?: string;
			status?: string;
			expiresAt?: string;
			payload?: Record<string, unknown>;
		},
	) => {
		const status = row.status ?? "approved";
		insert.run(
			id,
			`tedi-${sequence % 7}`,
			row.org ?? ORG,
			row.actionType ?? "custom",
			JSON.stringify(row.payload ?? {}),
			status,
			at(30 * DAY + sequence++ * 1000),
			row.expiresAt ?? at(29 * DAY),
			status === "pending" ? null : at(29 * DAY),
		);
	};
	const call = (
		execution: Record<string, unknown> | null,
		extra: Record<string, unknown> = {},
	) => ({
		kind: "mcp_tool_call",
		target: { transport: "rpc", endpoint: ENDPOINT },
		args: { dryRun: false },
		...(execution ? { execution } : {}),
		...extra,
	});
	const toolCall = (
		id: string,
		payload: Record<string, unknown>,
		row: { org?: string; status?: string; expiresAt?: string } = {},
	) =>
		add(id, {
			actionType: "mcp.tool_call",
			expiresAt: at(-DAY),
			payload,
			...row,
		});

	// History: almost every request was answered or closed long ago.
	for (let i = 0; i < 700; i++)
		add(`history-${i}`, {
			org: i % 5 ? ORG : OTHER_ORG,
			status: ["approved", "rejected", "expired", "cancelled"][i % 4],
			actionType: i % 3 ? "custom" : "bash_exec",
		});
	// Tool calls that ran, most of them in a window long past.
	for (let i = 0; i < 400; i++)
		toolCall(
			`ran-${i}`,
			call({ status: "executed", startedAt: at(20 * DAY) }),
			{
				org: i % 6 ? ORG : OTHER_ORG,
				expiresAt: i % 10 ? at(19 * DAY) : at(-DAY),
			},
		);

	// Pending requests: some past their window, some still open.
	for (let i = 0; i < 12; i++)
		add(`pending-expired-${i}`, {
			org: i % 3 ? ORG : OTHER_ORG,
			status: "pending",
			expiresAt: at((i + 1) * HOUR),
		});
	for (let i = 0; i < 9; i++)
		add(`pending-open-${i}`, {
			org: i % 3 ? ORG : OTHER_ORG,
			status: "pending",
			expiresAt: at(-(i + 1) * HOUR),
			...(i % 2 ? { actionType: "mcp.tool_call", payload: call(null) } : {}),
		});
	// Already closed: the sweep must leave these alone.
	add("expired-long-ago", { status: "expired", expiresAt: at(DAY) });
	add("rejected-past-window", { status: "rejected", expiresAt: at(DAY) });

	// Tool calls waiting for the queue.
	const queued = (nextAttemptAt: string) => ({
		status: "queued",
		startedAt: at(2 * HOUR),
		nextAttemptAt,
	});
	const running = (startedAt: string) => ({
		status: "running",
		startedAt,
		nextAttemptAt: at(3 * HOUR),
	});
	const failed = (error: string) => ({
		status: "failed",
		startedAt: at(2 * HOUR),
		error,
	});
	const stale = at(STALE_OWNER_TOOL_RUN_MS + HOUR);
	toolCall("queued-due-1h", call(queued(at(HOUR))));
	toolCall("queued-due-2h-other-org", call(queued(at(2 * HOUR))), {
		org: OTHER_ORG,
	});
	// Two runs due at the same instant: the id breaks the tie.
	const tie = at(90 * 60_000);
	toolCall("queued-tie-b", call(queued(tie)));
	toolCall("queued-tie-a", call(queued(tie)));
	toolCall("queued-not-due", call(queued(at(-HOUR))));
	toolCall("queued-consumed", call(queued(at(HOUR)), { consumedAt: at(HOUR) }));
	toolCall(
		"queued-dismissed",
		call({ ...queued(at(HOUR)), dismissedAt: at(HOUR / 2) }),
	);
	toolCall("queued-other-kind", {
		...call(queued(at(HOUR))),
		kind: "something_else",
	});
	// A due run whose window has passed is still listed: the caller closes it.
	toolCall("queued-window-passed", call(queued(at(HOUR))), {
		expiresAt: at(HOUR / 2),
	});
	toolCall("queued-but-pending", call(queued(at(HOUR))), {
		status: "pending",
	});
	toolCall("queued-but-rejected", call(queued(at(HOUR))), {
		status: "rejected",
	});
	add("queued-other-action", {
		actionType: "custom",
		expiresAt: at(-DAY),
		payload: call(queued(at(HOUR))),
	});
	toolCall("running-fresh", call(running(at(60_000))));
	toolCall("running-stale", call(running(stale)));
	toolCall(
		"running-stale-consumed",
		call(running(stale), {
			consumedAt: at(HOUR),
		}),
	);
	toolCall("running-stale-window-passed", call(running(stale)), {
		expiresAt: at(HOUR / 2),
	});
	toolCall("running-stale-dry-run", {
		...call(running(stale), { consumedAt: at(HOUR) }),
		args: { dryRun: true },
	});
	toolCall("running-stale-other-endpoint", {
		...call(running(stale), { consumedAt: at(HOUR) }),
		target: { transport: "rpc", endpoint: "example.other" },
	});
	toolCall("running-stale-mcp-transport", {
		...call(running(stale), { consumedAt: at(HOUR) }),
		target: { transport: "mcp", endpoint: ENDPOINT },
	});
	toolCall(
		"running-stale-dismissed",
		call(
			{ ...running(stale), dismissedAt: at(HOUR) },
			{ consumedAt: at(HOUR) },
		),
	);
	for (let i = 0; i < 6; i++)
		toolCall(
			`failed-transient-${i}`,
			call(
				failed(i % 2 ? "SERVICE_UNAVAILABLE: busy" : "the gateway timed out"),
				{
					consumedAt: at(HOUR),
					...(i % 3 ? { transientRetries: i } : {}),
				},
			),
			{ org: i % 2 ? ORG : OTHER_ORG },
		);
	toolCall(
		"failed-transient-exhausted",
		call(failed("SERVICE_UNAVAILABLE"), { transientRetries: 30 }),
	);
	toolCall("failed-refused", call(failed("FORBIDDEN: scope required")));
	toolCall("failed-transient-window-passed", call(failed("timed out")), {
		expiresAt: at(HOUR / 2),
	});
	toolCall(
		"failed-transient-dismissed",
		call({ ...failed("timed out"), dismissedAt: at(HOUR) }),
	);
	// Failures nobody dismissed stay in the index; they are old and expired.
	for (let i = 0; i < 40; i++)
		toolCall(`failed-old-${i}`, call(failed("timed out")), {
			org: i % 4 ? ORG : OTHER_ORG,
			expiresAt: at((i + 2) * DAY),
		});

	if (!withIndexes) sqlite.exec(`DROP INDEX ${PENDING}; DROP INDEX ${RUNS};`);
	// The table held about 53,650 rows on 17 Nov 2026 (each sweep read that
	// many per call). These statistics give the older indexes that size and,
	// like a database that has not been analysed since the migration, hold
	// no row for the two new ones. The per-key figures are estimates.
	if (statistics === "production-sized")
		sqlite.exec(`ANALYZE;
			DELETE FROM sqlite_stat1 WHERE tbl = 'tedi_approval_requests';
			INSERT INTO sqlite_stat1(tbl,idx,stat) VALUES
				('tedi_approval_requests','idx_approval_requests_resolved','53650 2'),
				('tedi_approval_requests','idx_approval_requests_status','53650 600 150'),
				('tedi_approval_requests','idx_approval_requests_tedi_status','53650 60 20');
			ANALYZE sqlite_schema;`);
	else if (statistics !== "none") {
		sqlite.exec("ANALYZE");
		if (statistics === "analysed before the indexes")
			sqlite.exec(
				`DELETE FROM sqlite_stat1 WHERE idx IN ('${PENDING}', '${RUNS}'); ANALYZE sqlite_schema;`,
			);
	}

	const plans: string[] = [];
	const explain = (query: string) =>
		sqlite
			.prepare(`EXPLAIN QUERY PLAN ${query}`)
			.all(...Array((query.match(/\?/g) ?? []).length).fill(null))
			.map((row) => String(row.detail))
			.join(" | ");
	const db = createDbClient(
		createD1Facade({
			prepare(query) {
				if (query.includes("tedi_approval_requests"))
					plans.push(explain(query));
				return sqlite.prepare(query);
			},
			exec: (query) => sqlite.exec(query),
		}),
	);
	return { sqlite, db, plans, explain, at, now };
}

const ids = (
	sqlite: DatabaseSync,
	query: string,
	...params: (string | number)[]
) =>
	sqlite
		.prepare(query)
		.all(...params)
		.map((row) => String(row.id));

const snapshot = (sqlite: DatabaseSync) =>
	new Map(
		sqlite
			.prepare(
				"SELECT id, status, resolved_at, resolved_by, resolution, payload FROM tedi_approval_requests",
			)
			.all()
			.map((row) => [String(row.id), JSON.stringify(row)]),
	);

function changed(before: Map<string, string>, after: Map<string, string>) {
	return [...after]
		.filter(([id, row]) => before.get(id) !== row)
		.map(([id]) => id)
		.sort();
}

/** A walk of the whole table is what these sweeps did before. */
function expectNoTableWalk(plans: string[]) {
	expect(plans.length).toBeGreaterThan(0);
	for (const plan of plans)
		expect(plan).not.toMatch(/SCAN tedi_approval_requests(?! USING INDEX)/);
}

describe.each<{ statistics: Statistics }>([
	{ statistics: "none" },
	{ statistics: "production-sized" },
	{ statistics: "analysed before the indexes" },
	{ statistics: "analysed" },
])("approval sweeps, statistics: $statistics", ({ statistics }) => {
	it("expires pending requests through the pending index, the same rows as before", async () => {
		const { sqlite, db, plans } = fixture(statistics);
		const expected = ids(
			sqlite,
			LEGACY_EXPIRE,
			"pending",
			new Date().toISOString(),
		);
		expect(expected).toHaveLength(12);
		const before = snapshot(sqlite);
		expect(await expireStaleApprovals(db)).toBe(12);
		expect(changed(before, snapshot(sqlite))).toEqual([...expected].sort());
		expect(plans).toEqual([
			`SEARCH tedi_approval_requests USING INDEX ${PENDING} (expires_at<?)`,
		]);
		expect(
			ids(
				sqlite,
				"SELECT id FROM tedi_approval_requests WHERE status = 'pending' ORDER BY id",
			),
		).toEqual([
			...Array.from({ length: 9 }, (_, i) => `pending-open-${i}`),
			"queued-but-pending",
		]);
		expect(await expireStaleApprovals(db)).toBe(0);
	});

	it("expires one organization's pending requests without walking the table, the same rows as before", async () => {
		const { sqlite, db, plans } = fixture(statistics);
		const expected = ids(
			sqlite,
			LEGACY_EXPIRE_ORG,
			"pending",
			new Date().toISOString(),
			ORG,
		);
		expect(expected).toHaveLength(8);
		const before = snapshot(sqlite);
		expect(
			await expireStaleApprovals(db, {
				organizationId: ORG,
				resolvedBy: "user-example",
			}),
		).toBe(8);
		expect(changed(before, snapshot(sqlite))).toEqual([...expected].sort());
		expect(plans).toHaveLength(1);
		expect(plans[0]).toBe(
			"SEARCH tedi_approval_requests USING INDEX idx_approval_requests_execution_attention (org_id=? AND status=?)",
		);
		expect(
			sqlite
				.prepare(
					"SELECT status, resolved_by, resolution FROM tedi_approval_requests WHERE id = 'pending-expired-1'",
				)
				.get(),
		).toEqual({
			status: "expired",
			resolved_by: "user-example",
			resolution: "Expired: no one answered in time, so it did not run.",
		});
	});

	it("lists due tool calls by seeking the two run states, the same rows in the same order as before", async () => {
		const { sqlite, db, plans, at } = fixture(statistics);
		const now = at(0);
		const staleBefore = new Date(
			Date.parse(now) - STALE_OWNER_TOOL_RUN_MS,
		).toISOString();
		const legacy = (limit: number) =>
			ids(
				sqlite,
				LEGACY_DUE,
				"mcp.tool_call",
				"approved",
				staleBefore,
				now,
				limit,
			);
		expect(legacy(100)).toEqual([
			"running-stale",
			"running-stale-window-passed",
			"queued-due-2h-other-org",
			"queued-tie-a",
			"queued-tie-b",
			"queued-due-1h",
			"queued-window-passed",
		]);
		for (const limit of [1, 3, 5, 100]) {
			plans.length = 0;
			const rows = await listDueOwnerToolApprovals(db, now, limit);
			expect(rows.map((row) => row.id)).toEqual(legacy(limit));
			expect(plans).toHaveLength(1);
			expect(plans[0]).toContain(
				"SEARCH tedi_approval_requests USING INDEX idx_approval_requests_unconsumed (consumed_at=? AND execution_status=?)",
			);
			expectNoTableWalk(plans);
		}
		const [first] = await listDueOwnerToolApprovals(db, now, 1);
		expect(first).toMatchObject({
			id: "running-stale",
			orgId: ORG,
			actionType: "mcp.tool_call",
			status: "approved",
			payload: { kind: "mcp_tool_call", execution: { status: "running" } },
		});
		// Nothing is due an hour before the earliest attempt time.
		expect(await listDueOwnerToolApprovals(db, at(4 * HOUR))).toEqual([]);
	});

	it("re-queues interrupted tool calls by seeking run state and window, the same rows as before", async () => {
		const { sqlite, db, plans, at } = fixture(statistics);
		const now = at(0);
		const staleBefore = at(STALE_OWNER_TOOL_RUN_MS);
		for (let round = 0; round < 2; round++) {
			const expected = ids(
				sqlite,
				LEGACY_REQUEUE,
				"mcp.tool_call",
				"approved",
				now,
				ENDPOINT,
				staleBefore,
				30,
			).sort();
			const before = snapshot(sqlite);
			plans.length = 0;
			expect(
				await requeueStaleContinuableOwnerToolApprovals(db, {
					now,
					staleBefore,
					endpoints: [ENDPOINT],
				}),
			).toBe(expected.length);
			expect(changed(before, snapshot(sqlite))).toEqual(expected);
			expect(plans).toEqual([
				`SEARCH tedi_approval_requests USING INDEX ${RUNS} (execution_status=? AND expires_at>?)`,
			]);
			// Two stale runs and six transient failures, then nothing.
			expect(expected).toEqual(
				round === 0
					? [
							...Array.from({ length: 6 }, (_, i) => `failed-transient-${i}`),
							"running-stale",
							"running-stale-consumed",
						]
					: [],
			);
		}
		expect(
			sqlite
				.prepare(
					"SELECT json_extract(payload, '$.execution.status') AS status, json_extract(payload, '$.consumedAt') AS consumed, json_extract(payload, '$.transientRetries') AS retries FROM tedi_approval_requests WHERE id = 'failed-transient-2'",
				)
				.get(),
		).toEqual({ status: "queued", consumed: null, retries: 3 });
	});

	it("leaves every other read of approvals off the new indexes", async () => {
		const { db, plans, explain, at } = fixture(statistics);
		await listApprovalRequests(db, { orgId: ORG, status: "pending" });
		await listApprovalRequests(db, {
			orgId: ORG,
			executionAttentionOnly: true,
		});
		await listApprovalRequests(db, { orgId: ORG, tediId: "tedi-1" });
		await findPendingOwnerToolApproval(db, {
			organizationId: ORG,
			fingerprint: "fingerprint-example",
			now: at(0),
		});
		await countPendingApprovalsByTedi(db, ORG);
		expect(plans.length).toBeGreaterThanOrEqual(7);
		for (const plan of plans) {
			expect(plan).not.toContain(PENDING);
			expect(plan).not.toContain(RUNS);
		}
		// SQLite refuses a partial index whose condition the query does not
		// state, so this cannot change with the statistics. A status passed
		// as a parameter, which is how every other read passes it, does not
		// state it.
		for (const query of [
			`SELECT id FROM tedi_approval_requests INDEXED BY ${PENDING} WHERE status = ? AND expires_at < ?`,
			`SELECT id FROM tedi_approval_requests INDEXED BY ${PENDING} WHERE org_id = ? AND status = ? AND expires_at > ?`,
			`SELECT id FROM tedi_approval_requests INDEXED BY ${PENDING} WHERE expires_at > ? ORDER BY expires_at`,
			`SELECT id FROM tedi_approval_requests INDEXED BY ${PENDING} WHERE status = 'approved' AND expires_at > ?`,
			`SELECT id FROM tedi_approval_requests INDEXED BY ${RUNS} WHERE status = ? AND action_type = ? AND expires_at > ?`,
			`SELECT id FROM tedi_approval_requests INDEXED BY ${RUNS} WHERE org_id = ? AND status = 'approved' AND action_type = 'mcp.tool_call' AND json_extract(payload, '$.execution.status') IN ('queued', 'running', 'failed')`,
			`SELECT id FROM tedi_approval_requests INDEXED BY ${RUNS} WHERE status = 'approved' AND action_type = 'mcp.tool_call' AND json_extract(payload, '$.execution.status') = 'queued' AND json_extract(payload, '$.execution.dismissedAt') IS NULL`,
			`SELECT id FROM tedi_approval_requests INDEXED BY ${RUNS} WHERE json_extract(payload, '$.execution.status') = 'queued' AND expires_at > ?`,
		])
			expect(() => explain(query)).toThrow(/no query solution/);
	});
});

it("answers the same on a database that does not have the indexes yet", async () => {
	const { sqlite, db, at } = fixture("analysed", false);
	const now = at(0);
	const staleBefore = at(STALE_OWNER_TOOL_RUN_MS);
	const due = ids(
		sqlite,
		LEGACY_DUE,
		"mcp.tool_call",
		"approved",
		staleBefore,
		now,
		100,
	);
	expect(
		(await listDueOwnerToolApprovals(db, now)).map((row) => row.id),
	).toEqual(due);
	const requeue = ids(
		sqlite,
		LEGACY_REQUEUE,
		"mcp.tool_call",
		"approved",
		now,
		ENDPOINT,
		staleBefore,
		30,
	);
	expect(requeue).toHaveLength(8);
	expect(
		await requeueStaleContinuableOwnerToolApprovals(db, {
			now,
			staleBefore,
			endpoints: [ENDPOINT],
		}),
	).toBe(8);
	const expire = ids(
		sqlite,
		LEGACY_EXPIRE,
		"pending",
		new Date().toISOString(),
	);
	expect(await expireStaleApprovals(db)).toBe(expire.length);
});
