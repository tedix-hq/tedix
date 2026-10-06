import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import {
	attachWorkItemSource,
	getSourceFreshness,
	listWorkItemSources,
	markMissingSources,
	tombstoneMissingSources,
	WorkItemSourceError,
} from "./work-item-sources";

const ORG = "org-1";
const OTHER_ORG = "org-2";
const PROJECT = "proj-acme";
const T0 = "2026-08-01T00:00:00.000Z";
const T1 = "2026-08-02T00:00:00.000Z";
const T5 = "2026-08-06T00:00:00.000Z";

const DDL = `
CREATE TABLE projects (
	id TEXT PRIMARY KEY NOT NULL,
	org_id TEXT NOT NULL,
	key TEXT NOT NULL,
	name TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'active',
	created_at TEXT NOT NULL
);
CREATE TABLE work_items (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
 disposition TEXT NOT NULL DEFAULT 'proposed', work_kind TEXT NOT NULL DEFAULT 'other', risk_level TEXT NOT NULL DEFAULT 'medium', acceptance_contract TEXT,
 required_capabilities TEXT NOT NULL DEFAULT '[]', required_authorities TEXT NOT NULL DEFAULT '[]', admission_spec_revision TEXT NOT NULL DEFAULT 'test-revision',
 priority TEXT NOT NULL DEFAULT 'medium', accountable_owner_type TEXT, accountable_owner_id TEXT, steward_type TEXT, steward_id TEXT, reviewer_type TEXT, reviewer_id TEXT,
 objective_id TEXT, work_class TEXT, purpose_exception_expires_at TEXT, project_id TEXT, parent_work_item_id TEXT, source_session_key TEXT, source_intent_id TEXT, due_date TEXT, deadline TEXT, start_at TEXT, duration_days INTEGER,
 provenance TEXT DEFAULT '{}', metadata TEXT DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT, accepted_at TEXT, completed_at TEXT, cancelled_at TEXT, version INTEGER NOT NULL DEFAULT 1, UNIQUE (org_id, id)
);
CREATE TABLE work_item_sources (
	id TEXT PRIMARY KEY NOT NULL,
	org_id TEXT NOT NULL,
	project_id TEXT,
	work_item_id TEXT,
	provider TEXT NOT NULL,
	external_id TEXT NOT NULL,
	kind TEXT NOT NULL DEFAULT 'other',
	external_url TEXT,
	title TEXT,
	content_hash TEXT,
	state TEXT NOT NULL DEFAULT 'current',
	last_checked_at TEXT,
	last_changed_at TEXT,
	missing_since_at TEXT,
	tombstoned_at TEXT,
	attributed_to TEXT,
	metadata TEXT DEFAULT '{}',
	created_at TEXT NOT NULL,
	updated_at TEXT
);
CREATE UNIQUE INDEX uniq_work_item_source_owner_external
	ON work_item_sources (org_id, provider, external_id, coalesce(project_id, ''), coalesce(work_item_id, ''));
`;

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(DDL);
	sqlite
		.prepare(
			"INSERT INTO projects (id, org_id, key, name, status, created_at) VALUES (?,?,?,?,?,?)",
		)
		.run(PROJECT, ORG, "ACME", "acme", "active", T0);
	sqlite
		.prepare(
			"INSERT INTO work_items (id, org_id, title, project_id, created_at) VALUES (?,?,?,?,?)",
		)
		.run("w1", ORG, "Engagement Status", PROJECT, T0);
	return { db: createDbClient(createD1Facade(sqlite)), sqlite };
}

function attach(
	db: ReturnType<typeof fixture>["db"],
	over: Record<string, unknown> = {},
) {
	return attachWorkItemSource(db, {
		id: "s1",
		orgId: ORG,
		projectId: PROJECT,
		provider: "notion",
		externalId: "page-1",
		kind: "page",
		externalUrl: "https://notion.so/page-1",
		title: "Acme — AI Workflow Activation Pilot",
		contentHash: "hash-a",
		now: T0,
		...over,
	} as Parameters<typeof attachWorkItemSource>[1]);
}

describe("attachWorkItemSource", () => {
	it("requires an owner", async () => {
		const { db } = fixture();
		await expect(
			attach(db, { projectId: null, workItemId: null }),
		).rejects.toBeInstanceOf(WorkItemSourceError);
	});

	it("rejects an owner from another org", async () => {
		const { db, sqlite } = fixture();
		sqlite
			.prepare(
				"INSERT INTO projects (id, org_id, key, name, status, created_at) VALUES (?,?,?,?,?,?)",
			)
			.run("foreign", OTHER_ORG, "X", "x", "active", T0);
		await expect(attach(db, { projectId: "foreign" })).rejects.toMatchObject({
			reason: "owner_wrong_org",
		});
	});

	it("is idempotent: re-attaching an unchanged source only refreshes the check", async () => {
		const { db } = fixture();
		await attach(db);
		const again = await attach(db, { id: "s-other", now: T1 });

		expect(again.id).toBe("s1"); // same row, not a duplicate
		expect(again.state).toBe("current");
		expect(again.lastCheckedAt).toBe(T1);
		expect(again.lastChangedAt).toBeNull();

		const { total } = await listWorkItemSources(db, { orgId: ORG });
		expect(total).toBe(1);
	});

	it("flags a moved content hash as changed and stamps when it moved", async () => {
		const { db } = fixture();
		await attach(db);
		const moved = await attach(db, { contentHash: "hash-b", now: T1 });

		expect(moved.state).toBe("changed");
		expect(moved.lastChangedAt).toBe(T1);
		expect(moved.contentHash).toBe("hash-b");
	});

	it("lets the same source attach to a project AND a work item", async () => {
		const { db } = fixture();
		await attach(db);
		await attach(db, { id: "s2", projectId: null, workItemId: "w1" });

		const { total } = await listWorkItemSources(db, { orgId: ORG });
		expect(total).toBe(2);
		const byItem = await listWorkItemSources(db, {
			orgId: ORG,
			workItemId: "w1",
		});
		expect(byItem.data.map((r) => r.id)).toEqual(["s2"]);
	});
});

describe("reconciliation ladder", () => {
	it("marks sources the sweep did not see as missing, sparing the ones it did", async () => {
		const { db } = fixture();
		await attach(db);
		await attach(db, { id: "s2", externalId: "page-2" });

		const { marked } = await markMissingSources(db, {
			orgId: ORG,
			provider: "notion",
			seenExternalIds: ["page-1"],
			now: T1,
		});
		expect(marked).toBe(1);

		const all = await listWorkItemSources(db, { orgId: ORG });
		const states = Object.fromEntries(
			all.data.map((r) => [r.externalId, r.state]),
		);
		expect(states).toEqual({ "page-1": "current", "page-2": "missing" });
	});

	it("does not tombstone inside the grace period, and does after it", async () => {
		const { db } = fixture();
		await attach(db);
		await markMissingSources(db, {
			orgId: ORG,
			provider: "notion",
			seenExternalIds: [],
			now: T0,
		});

		const early = await tombstoneMissingSources(db, { orgId: ORG, now: T1 });
		expect(early.tombstoned).toEqual([]); // 24h < 72h grace

		const late = await tombstoneMissingSources(db, { orgId: ORG, now: T5 });
		expect(late.tombstoned).toEqual(["s1"]);
	});

	it("revives a tombstoned source that reappears upstream", async () => {
		const { db } = fixture();
		await attach(db);
		await markMissingSources(db, {
			orgId: ORG,
			provider: "notion",
			seenExternalIds: [],
			now: T0,
		});
		await tombstoneMissingSources(db, { orgId: ORG, now: T5 });

		const revived = await attach(db, { now: T5 });
		expect(revived.state).toBe("current");
		expect(revived.tombstonedAt).toBeNull();
		expect(revived.missingSinceAt).toBeNull();
	});

	it("hides tombstoned sources from live reads but keeps them as evidence", async () => {
		const { db } = fixture();
		await attach(db);
		await markMissingSources(db, {
			orgId: ORG,
			provider: "notion",
			seenExternalIds: [],
			now: T0,
		});
		await tombstoneMissingSources(db, { orgId: ORG, now: T5 });

		const live = await listWorkItemSources(db, { orgId: ORG });
		expect(live.total).toBe(0);

		const withEvidence = await listWorkItemSources(db, {
			orgId: ORG,
			includeTombstoned: true,
		});
		expect(withEvidence.total).toBe(1);
		expect(withEvidence.data[0]?.tombstonedAt).toBe(T5);
	});

	it("chunks a wide seen-set without dropping the exclusion", async () => {
		const { db } = fixture();
		await attach(db);
		await attach(db, { id: "s2", externalId: "gone" });
		// Wider than SEEN_ID_CHUNK, so the NOT IN is split across conditions.
		const seen = ["page-1", ...Array.from({ length: 120 }, (_, i) => `x${i}`)];

		const { marked } = await markMissingSources(db, {
			orgId: ORG,
			provider: "notion",
			seenExternalIds: seen,
			now: T1,
		});
		expect(marked).toBe(1);

		const all = await listWorkItemSources(db, { orgId: ORG });
		const states = Object.fromEntries(
			all.data.map((r) => [r.externalId, r.state]),
		);
		expect(states).toEqual({ "page-1": "current", gone: "missing" });
	});
});

describe("getSourceFreshness", () => {
	it("reports index rot by state and the oldest check", async () => {
		const { db } = fixture();
		await attach(db);
		await attach(db, { id: "s2", externalId: "page-2", now: T1 });
		await attach(db, {
			id: "s3",
			externalId: "page-3",
			contentHash: null,
			now: T1,
		});
		await markMissingSources(db, {
			orgId: ORG,
			provider: "notion",
			seenExternalIds: ["page-1", "page-3"],
			now: T1,
		});

		const report = await getSourceFreshness(db, {
			orgId: ORG,
			projectId: PROJECT,
		});
		expect(report.total).toBe(3);
		expect(report.byState.missing).toBe(1);
		expect(report.oldestCheckedAt).toBe(T0);
		// Attached by reference with no hash — never content-checked.
		expect(report.neverChecked).toBe(1);
	});
});
