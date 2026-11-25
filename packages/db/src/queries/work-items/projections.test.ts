import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { gitCommitAliases } from "../../schema/git-commit-aliases";
import { schemaDdl } from "../../test/schema-ddl";
import { listOrgWorkAttempts, listOrgWorkRecovery } from "./projections";

const DDL = `
CREATE TABLE work_items (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
 disposition TEXT NOT NULL, work_kind TEXT NOT NULL, risk_level TEXT NOT NULL,
 acceptance_contract TEXT, required_capabilities TEXT NOT NULL DEFAULT '[]',
 required_authorities TEXT NOT NULL DEFAULT '[]', admission_spec_revision TEXT NOT NULL DEFAULT 'test-revision',
 priority TEXT NOT NULL, accountable_owner_type TEXT,
 accountable_owner_id TEXT, project_id TEXT, executor_type TEXT, executor_id TEXT,
 dispatch_state TEXT, created_at TEXT NOT NULL, updated_at TEXT,
 metadata TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE work_attempts (
 id TEXT PRIMARY KEY, admission_id TEXT, work_item_id TEXT NOT NULL, org_id TEXT NOT NULL,
 executor_type TEXT NOT NULL, executor_id TEXT NOT NULL, executor_session_id TEXT,
 external_session_key TEXT, run_id TEXT, runtime_state TEXT NOT NULL, outcome TEXT,
 attempt_number INTEGER NOT NULL, started_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL,
 expires_at TEXT, finished_at TEXT, summary TEXT, version INTEGER NOT NULL DEFAULT 1,
 metadata TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE work_item_relations (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, from_work_item_id TEXT NOT NULL,
 to_work_item_id TEXT NOT NULL, relation_type TEXT NOT NULL
);
`;

function fixture(statements: string[] = []) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(DDL);
	sqlite.exec(schemaDdl(gitCommitAliases));
	return {
		sqlite,
		db: createDbQueryClient(
			createD1Facade(sqlite, {
				onPrepare: (query) => {
					statements.push(query);
				},
			}),
		),
	};
}

it("resolves 50 attempt rows with 100 distinct commit fields in two alias statements", async () => {
	const statements: string[] = [];
	const { sqlite, db } = fixture(statements);
	seedItem(sqlite, { id: "item", createdAt: "2026-08-20T10:00:00Z" });
	const expected = new Map<string, Record<string, unknown>>();
	const stored = new Map<string, Record<string, unknown>>();
	for (let i = 0; i < 50; i++) {
		const old = [i * 2, i * 2 + 1].map(
			(n) => `a${n.toString(16).padStart(39, "0")}`,
		);
		const canonical = [i * 2, i * 2 + 1].map(
			(n) => `b${n.toString(16).padStart(39, "0")}`,
		);
		for (let j = 0; j < 2; j++)
			await db
				.insert(gitCommitAliases)
				.values({
					oldSha: old[j]!,
					newSha: canonical[j]!,
					repository: "example/product",
				});
		const id = `attempt-${i}`;
		seedAttempt(sqlite, {
			id,
			itemId: "item",
			startedAt: "2026-08-20T10:00:00Z",
		});
		const settlement =
			i === 0
				? {
						mode: "local_branch",
						evidenceId: "00000000-0000-4000-8000-000000000001",
						evidenceUri: "artifact://test/proof",
						branch: "example",
						baseCommit: old[0],
						commitSha: old[1],
						commitShas: old,
					}
				: {
						mode: "repository_commit",
						repository: "example/product",
						commitSha: old[0],
						runCommitSha: old[1],
						runId: 1,
						runAttempt: 1,
						evidenceUri: "artifact://test/proof",
					};
		stored.set(id, { settlement });
		expected.set(id, {
			settlement:
				i === 0
					? {
							...settlement,
							baseCommit: canonical[0],
							commitSha: canonical[1],
							commitShas: canonical,
						}
					: {
							...settlement,
							commitSha: canonical[0],
							runCommitSha: canonical[1],
						},
		});
		sqlite
			.prepare("UPDATE work_attempts SET metadata = ? WHERE id = ?")
			.run(JSON.stringify({ settlement }), id);
	}
	statements.length = 0;
	const page = await listOrgWorkAttempts(db, { orgId: "org-a", limit: 50 });
	expect(page.data).toHaveLength(50);
	for (const row of page.data)
		expect(row.attempt.metadata).toEqual(expected.get(row.attempt.id));
	expect(
		statements.filter((query) => query.includes('from "git_commit_aliases"')),
	).toHaveLength(2);
	for (const row of sqlite
		.prepare("SELECT id, metadata FROM work_attempts")
		.all() as { id: string; metadata: string }[])
		expect(JSON.parse(row.metadata)).toEqual(stored.get(row.id));
	sqlite.close();
});

function seedItem(
	sqlite: DatabaseSync,
	params: {
		id: string;
		orgId?: string;
		projectId?: string;
		createdAt: string;
		capabilities?: string[];
	},
) {
	sqlite
		.prepare(
			`INSERT INTO work_items
			(id,org_id,title,disposition,work_kind,risk_level,required_capabilities,
			required_authorities,priority,accountable_owner_type,
			accountable_owner_id,project_id,created_at)
			VALUES (?,?,?,'accepted','coding','medium',?,'[]','high','team','platform',?,?)`,
		)
		.run(
			params.id,
			params.orgId ?? "org-a",
			`Item ${params.id}`,
			JSON.stringify(params.capabilities ?? []),
			params.projectId ?? null,
			params.createdAt,
		);
}

function seedAttempt(
	sqlite: DatabaseSync,
	params: {
		id: string;
		itemId: string;
		orgId?: string;
		startedAt: string;
		state?: string;
		outcome?: string;
		expiresAt?: string;
		attemptNumber?: number;
	},
) {
	sqlite
		.prepare(
			`INSERT INTO work_attempts
			(id,work_item_id,org_id,executor_type,executor_id,runtime_state,outcome,
			attempt_number,started_at,heartbeat_at,expires_at,finished_at,metadata)
			VALUES (?,?,?,'external_agent','agent',?,?,?,?,?,?,?, '{}')`,
		)
		.run(
			params.id,
			params.itemId,
			params.orgId ?? "org-a",
			params.state ?? "finished",
			params.outcome ?? (params.state === "running" ? null : "succeeded"),
			params.attemptNumber ?? 1,
			params.startedAt,
			params.startedAt,
			params.expiresAt ?? null,
			params.state === "running" ? null : params.startedAt,
		);
}

describe("org-wide Work factory projections", () => {
	it("pages attempts by a stable compound cursor and never crosses orgs", async () => {
		const { sqlite, db } = fixture();
		seedItem(sqlite, { id: "item-a", createdAt: "2026-08-20T10:00:00Z" });
		seedItem(sqlite, { id: "item-b", createdAt: "2026-08-20T10:00:00Z" });
		seedItem(sqlite, {
			id: "item-other",
			orgId: "org-b",
			createdAt: "2026-08-20T10:00:00Z",
		});
		seedAttempt(sqlite, {
			id: "attempt-b",
			itemId: "item-b",
			startedAt: "2026-08-20T12:00:00Z",
		});
		seedAttempt(sqlite, {
			id: "attempt-a",
			itemId: "item-a",
			startedAt: "2026-08-20T12:00:00Z",
		});
		seedAttempt(sqlite, {
			id: "attempt-other",
			itemId: "item-other",
			orgId: "org-b",
			startedAt: "2026-08-20T13:00:00Z",
		});

		const first = await listOrgWorkAttempts(db, { orgId: "org-a", limit: 1 });
		expect(first.data.map((row) => row.attempt.id)).toEqual(["attempt-b"]);
		expect(first.data[0]?.workItem.title).toBe("Item item-b");
		expect(first.hasMore).toBe(true);
		const second = await listOrgWorkAttempts(db, {
			orgId: "org-a",
			limit: 1,
			cursor: first.nextCursor!,
		});
		expect(second.data.map((row) => row.attempt.id)).toEqual(["attempt-a"]);
		expect(second.nextCursor).toBeNull();
	});

	it("returns factual recovery signals without treating active work as failed", async () => {
		const { sqlite, db } = fixture();
		seedItem(sqlite, {
			id: "needs-capability",
			createdAt: "2026-08-20T12:00:00Z",
			capabilities: ["browser"],
		});
		seedItem(sqlite, {
			id: "expired",
			createdAt: "2026-08-20T11:00:00Z",
		});
		seedItem(sqlite, { id: "running", createdAt: "2026-08-20T10:00:00Z" });
		seedItem(sqlite, {
			id: "lease-elapsed",
			createdAt: "2026-08-20T13:00:00Z",
		});
		seedAttempt(sqlite, {
			id: "expired-attempt",
			itemId: "expired",
			startedAt: "2026-08-20T12:00:00Z",
			state: "expired",
			outcome: "expired",
		});
		seedAttempt(sqlite, {
			id: "running-attempt",
			itemId: "running",
			startedAt: "2026-08-20T12:00:00Z",
			state: "running",
			outcome: undefined,
		});
		seedAttempt(sqlite, {
			id: "lease-elapsed-attempt",
			itemId: "lease-elapsed",
			startedAt: "2026-08-20T12:00:00Z",
			state: "running",
			expiresAt: "2026-08-20T13:00:00Z",
		});

		const page = await listOrgWorkRecovery(db, {
			orgId: "org-a",
			observedAt: "2026-08-20T14:00:00Z",
		});
		expect(page.data.map((row) => row.id)).toEqual([
			"lease-elapsed",
			"expired",
		]);
		expect(page.data[0]?.signals).toEqual(["attempt_lease_elapsed"]);
		expect(page.data[1]?.signals).toEqual(["latest_attempt_expired"]);
	});

	it("lists Work a runner holds with the runner's reason", async () => {
		const { sqlite, db } = fixture();
		seedItem(sqlite, { id: "runner-held", createdAt: "2026-08-20T12:00:00Z" });
		seedItem(sqlite, { id: "unplanned", createdAt: "2026-08-20T11:00:00Z" });
		seedItem(sqlite, { id: "ready", createdAt: "2026-08-20T10:00:00Z" });
		const plan = sqlite.prepare(
			"UPDATE work_items SET dispatch_state=?, metadata=? WHERE id=?",
		);
		plan.run(
			"held",
			JSON.stringify({ laneDispatch: { reason: "Three runs failed." } }),
			"runner-held",
		);
		// A coordinator's hold has no reason: the Work only waits its turn.
		plan.run("held", "{}", "unplanned");
		plan.run(
			"ready",
			JSON.stringify({ laneDispatch: { reason: "stale" } }),
			"ready",
		);

		const page = await listOrgWorkRecovery(db, {
			orgId: "org-a",
			observedAt: "2026-08-20T14:00:00Z",
		});
		expect(page.data).toHaveLength(1);
		expect(page.data[0]).toMatchObject({
			id: "runner-held",
			signals: ["dispatch_held"],
			dispatchHoldReason: "Three runs failed.",
		});
		const failed = await listOrgWorkRecovery(db, {
			orgId: "org-a",
			observedAt: "2026-08-20T14:00:00Z",
			signal: "latest_attempt_failed",
		});
		expect(failed.data).toEqual([]);
	});

	it("judges each item by its highest-numbered attempt only", async () => {
		const { sqlite, db } = fixture();
		seedItem(sqlite, { id: "recovered", createdAt: "2026-08-20T10:00:00Z" });
		seedItem(sqlite, { id: "refailed", createdAt: "2026-08-20T11:00:00Z" });
		seedAttempt(sqlite, {
			id: "recovered-1",
			itemId: "recovered",
			startedAt: "2026-08-20T12:00:00Z",
			state: "failed",
			outcome: "failed",
		});
		seedAttempt(sqlite, {
			id: "recovered-2",
			itemId: "recovered",
			startedAt: "2026-08-20T11:00:00Z",
			attemptNumber: 2,
		});
		seedAttempt(sqlite, {
			id: "refailed-1",
			itemId: "refailed",
			startedAt: "2026-08-20T12:00:00Z",
		});
		seedAttempt(sqlite, {
			id: "refailed-2",
			itemId: "refailed",
			startedAt: "2026-08-20T12:30:00Z",
			state: "failed",
			outcome: "failed",
			attemptNumber: 2,
		});
		const page = await listOrgWorkRecovery(db, {
			orgId: "org-a",
			observedAt: "2026-08-20T14:00:00Z",
		});
		expect(page.data.map((row) => [row.id, row.latestAttemptId])).toEqual([
			["refailed", "refailed-2"],
		]);
	});
});
