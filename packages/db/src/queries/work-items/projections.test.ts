import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { listOrgWorkAttempts, listOrgWorkRecovery } from "./projections";

const DDL = `
CREATE TABLE work_items (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
 disposition TEXT NOT NULL, work_kind TEXT NOT NULL, risk_level TEXT NOT NULL,
 acceptance_contract TEXT, required_capabilities TEXT NOT NULL DEFAULT '[]',
 required_authorities TEXT NOT NULL DEFAULT '[]', admission_spec_revision TEXT NOT NULL DEFAULT 'test-revision',
 priority TEXT NOT NULL, accountable_owner_type TEXT,
 accountable_owner_id TEXT, project_id TEXT, created_at TEXT NOT NULL, updated_at TEXT
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

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(DDL);
	return { sqlite, db: createDbQueryClient(createD1Facade(sqlite)) };
}

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
	},
) {
	sqlite
		.prepare(
			`INSERT INTO work_attempts
			(id,work_item_id,org_id,executor_type,executor_id,runtime_state,outcome,
			attempt_number,started_at,heartbeat_at,expires_at,finished_at,metadata)
			VALUES (?,?,?,'external_agent','agent',?,?,1,?,?,?,?, '{}')`,
		)
		.run(
			params.id,
			params.itemId,
			params.orgId ?? "org-a",
			params.state ?? "finished",
			params.outcome ?? (params.state === "running" ? null : "succeeded"),
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
});
