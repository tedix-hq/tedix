/**
 * `listOrgWorkItemProjections` pages in SQL.
 *
 * Its caller used to ask for `offset + limit` rows and `.slice()` the page out
 * of them, so a deep page serialized every preceding row out of D1 only to throw
 * it away. These tests pin that a page beyond that old prefetch window is
 * correct and that offset pages neither repeat nor skip a row when many
 * projections share a `created_at`.
 */

import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { listOrgWorkItemProjections } from "./crud";

const ORG = "org-1";
const OTHER_ORG = "org-2";

const DDL = `
CREATE TABLE work_items (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
 disposition TEXT NOT NULL DEFAULT 'proposed', work_kind TEXT NOT NULL DEFAULT 'other',
 risk_level TEXT NOT NULL DEFAULT 'medium', acceptance_contract TEXT,
 required_capabilities TEXT NOT NULL DEFAULT '[]', required_authorities TEXT NOT NULL DEFAULT '[]',
 admission_spec_revision TEXT NOT NULL DEFAULT 'legacy', priority TEXT NOT NULL DEFAULT 'medium',
 accountable_owner_type TEXT, accountable_owner_id TEXT, steward_type TEXT, steward_id TEXT,
 reviewer_type TEXT, reviewer_id TEXT, reviewer_lease_expires_at TEXT,
 objective_id TEXT, work_class TEXT, purpose_exception_expires_at TEXT, project_id TEXT,
 parent_work_item_id TEXT, source_session_key TEXT, source_intent_id TEXT,
 due_date TEXT, deadline TEXT, start_at TEXT, duration_days INTEGER, provenance TEXT DEFAULT '{}', metadata TEXT DEFAULT '{}',
 created_at TEXT NOT NULL, updated_at TEXT, accepted_at TEXT, completed_at TEXT,
 cancelled_at TEXT, version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE work_item_projections (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, work_item_id TEXT NOT NULL, provider TEXT NOT NULL,
 direction TEXT NOT NULL DEFAULT 'outbound', status TEXT NOT NULL DEFAULT 'synced',
 external_id TEXT, external_url TEXT, last_synced_at TEXT, last_error TEXT,
 payload TEXT DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT,
 version INTEGER NOT NULL DEFAULT 1);
`;

let sqlite: DatabaseSync;
let db: ReturnType<typeof createDbQueryClient>;

/** Ordered ids so "expected page" is a plain slice of a known sequence. */
function idFor(index: number): string {
	return `proj-${index.toString().padStart(5, "0")}`;
}

/**
 * 260 rows: past the 100-row default page and past any window the previous
 * `limit: offset + limit` prefetch would have kept cheap. Every row shares one
 * `created_at`, so ordering rests entirely on the id tie-break.
 */
const SCALE = 260;
const SHARED_CREATED_AT = "2026-08-20T00:00:00.000Z";

beforeEach(() => {
	sqlite = new DatabaseSync(":memory:");
	sqlite.exec(DDL);
	db = createDbQueryClient(createD1Facade(sqlite));
	sqlite
		.prepare(
			`INSERT INTO work_items (id,org_id,title,created_at) VALUES ('w-1',?,'Item',?)`,
		)
		.run(ORG, SHARED_CREATED_AT);
	sqlite
		.prepare(
			`INSERT INTO work_items (id,org_id,title,created_at) VALUES ('w-other',?,'Other',?)`,
		)
		.run(OTHER_ORG, SHARED_CREATED_AT);
	const insert = sqlite.prepare(
		`INSERT INTO work_item_projections (id,org_id,work_item_id,provider,created_at) VALUES (?,?,?,?,?)`,
	);
	for (let index = 0; index < SCALE; index += 1) {
		insert.run(idFor(index), ORG, "w-1", "github", SHARED_CREATED_AT);
	}
	insert.run("proj-foreign", OTHER_ORG, "w-other", "github", SHARED_CREATED_AT);
});

/** Newest-first over equal timestamps is descending id. */
const EXPECTED = Array.from({ length: SCALE }, (_, index) =>
	idFor(SCALE - 1 - index),
);

describe("listOrgWorkItemProjections pages in SQL", () => {
	it("returns a page past the old prefetch window with an exact total", async () => {
		const page = await listOrgWorkItemProjections(db, {
			orgId: ORG,
			limit: 10,
			offset: 250,
		});
		expect(page.total).toBe(SCALE);
		expect(page.data.map((row) => row.id)).toEqual(EXPECTED.slice(250, 260));
	});

	it("never repeats or skips a row across offset pages", async () => {
		const seen: string[] = [];
		for (let offset = 0; offset < SCALE; offset += 25) {
			const page = await listOrgWorkItemProjections(db, {
				orgId: ORG,
				limit: 25,
				offset,
			});
			seen.push(...page.data.map((row) => row.id));
		}
		expect(seen).toEqual(EXPECTED);
		expect(new Set(seen).size).toBe(SCALE);
	});

	it("keeps the count scoped to the same predicate as the page", async () => {
		const page = await listOrgWorkItemProjections(db, {
			orgId: ORG,
			provider: "gitlab",
			limit: 25,
			offset: 0,
		});
		expect(page).toEqual({ data: [], total: 0 });
	});

	it("returns a short final page rather than wrapping", async () => {
		const page = await listOrgWorkItemProjections(db, {
			orgId: ORG,
			limit: 25,
			offset: 250,
		});
		expect(page.data).toHaveLength(10);
		expect(page.total).toBe(SCALE);
	});
});
