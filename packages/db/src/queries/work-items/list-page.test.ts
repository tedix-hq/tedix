import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { listWorkItemsPage } from "./crud";

const ORG = "org-1";
const OTHER_ORG = "org-2";
const OBJECTIVE = "objective-1";
const PROJECT = "project-1";

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
`;

let sqlite: DatabaseSync;
let db: ReturnType<typeof createDbQueryClient>;

function insert(row: {
	id: string;
	orgId?: string;
	title?: string;
	disposition?: string;
	workKind?: string;
	workClass?: string | null;
	objectiveId?: string | null;
	projectId?: string | null;
	createdAt?: string;
}) {
	sqlite
		.prepare(
			`INSERT INTO work_items
			 (id,org_id,title,disposition,work_kind,work_class,objective_id,project_id,created_at)
			 VALUES (?,?,?,?,?,?,?,?,?)`,
		)
		.run(
			row.id,
			row.orgId ?? ORG,
			row.title ?? "Seed",
			row.disposition ?? "proposed",
			row.workKind ?? "other",
			row.workClass ?? null,
			row.objectiveId ?? null,
			row.projectId ?? null,
			row.createdAt ?? "2026-08-20T00:00:00.000Z",
		);
}

/**
 * A hex id whose lexical order matches its insertion order, so "oldest" and
 * "lowest id" coincide and a prefix lookup for row 0 is the hardest case for a
 * newest-first window to satisfy.
 */
function idFor(index: number): string {
	const hex = index.toString(16).padStart(8, "0");
	return `${hex}-0000-4000-8000-000000000000`;
}

/**
 * 1,200 rows: more than the 1,000-row window the old in-memory implementation
 * prefetched, so anything it could not see is provably a defect, not a limit.
 */
const SCALE = 1_200;
const WINDOW = 1_000;

beforeEach(() => {
	sqlite = new DatabaseSync(":memory:");
	sqlite.exec(DDL);
	db = createDbQueryClient(createD1Facade(sqlite));
});

describe("listWorkItemsPage filters and counts in SQL", () => {
	it("counts and matches rows past the old 1,000-row prefetch window", async () => {
		for (let index = 0; index < SCALE; index += 1) {
			insert({
				id: idFor(index),
				// Newest first, so index 0 is the OLDEST row and index 1,199 the newest.
				createdAt: new Date(
					Date.UTC(2020, 0, 1) + index * 86_400_000,
				).toISOString(),
				workClass: index < 40 ? "maintenance" : "delivery",
				objectiveId: index < 40 ? OBJECTIVE : null,
				title: index < 40 ? `Ancient remediation ${index}` : `Recent ${index}`,
			});
		}
		insert({
			id: idFor(9_000),
			orgId: OTHER_ORG,
			title: "Ancient remediation x",
		});

		const all = await listWorkItemsPage(db, { orgId: ORG, limit: 1 });
		expect(all.total).toBe(SCALE);
		expect(all.total).toBeGreaterThan(WINDOW);

		// The 40 oldest rows all sort below the window; the old read saw none.
		for (const filter of [
			{ workClass: "maintenance" as const },
			{ objectiveId: OBJECTIVE },
			{ titleContains: "Ancient remediation" },
		]) {
			const page = await listWorkItemsPage(db, {
				orgId: ORG,
				limit: 100,
				...filter,
			});
			expect(page.total, JSON.stringify(filter)).toBe(40);
			expect(page.data, JSON.stringify(filter)).toHaveLength(40);
		}
	});

	it("resolves an id prefix for the oldest row in the org", async () => {
		for (let index = 0; index < SCALE; index += 1) {
			insert({
				id: idFor(index),
				createdAt: new Date(
					Date.UTC(2020, 0, 1) + index * 86_400_000,
				).toISOString(),
			});
		}
		const oldest = idFor(0);

		const byPrefix = await listWorkItemsPage(db, {
			orgId: ORG,
			idPrefix: oldest.slice(0, 8),
		});
		expect(byPrefix.total).toBe(1);
		expect(byPrefix.data.map((row) => row.id)).toEqual([oldest]);

		// The exact-id fast path resolves the same row.
		const byId = await listWorkItemsPage(db, { orgId: ORG, idPrefix: oldest });
		expect(byId.total).toBe(1);
		expect(byId.data[0]?.id).toBe(oldest);

		// A hyphenated fragment is still a pure prefix range, not a substring.
		const hyphenated = await listWorkItemsPage(db, {
			orgId: ORG,
			idPrefix: `${oldest.slice(0, 8)}-0000`,
		});
		expect(hyphenated.data.map((row) => row.id)).toEqual([oldest]);

		const missing = await listWorkItemsPage(db, {
			orgId: ORG,
			idPrefix: "ffffffff",
		});
		expect(missing.total).toBe(0);
		expect(missing.data).toEqual([]);
	});

	it("reports total over the filtered set, not the page or the table", async () => {
		for (let index = 0; index < 30; index += 1) {
			insert({
				id: idFor(index),
				disposition: index < 12 ? "completed" : "proposed",
				projectId: index < 12 ? PROJECT : null,
			});
		}
		const page = await listWorkItemsPage(db, {
			orgId: ORG,
			disposition: "completed",
			projectId: PROJECT,
			limit: 5,
		});
		expect(page.data).toHaveLength(5);
		expect(page.total).toBe(12);

		const unfiltered = await listWorkItemsPage(db, { orgId: ORG, limit: 5 });
		expect(unfiltered.total).toBe(30);
	});

	it("keeps offset pages disjoint when every created_at is identical", async () => {
		for (let index = 0; index < 25; index += 1) {
			insert({ id: idFor(index), createdAt: "2026-08-20T12:00:00.000Z" });
		}
		const seen: string[] = [];
		for (let offset = 0; offset < 25; offset += 10) {
			const page = await listWorkItemsPage(db, {
				orgId: ORG,
				limit: 10,
				offset,
			});
			expect(page.total).toBe(25);
			seen.push(...page.data.map((row) => row.id));
		}
		expect(new Set(seen).size).toBe(25);
		// Deterministic tie-break: created_at DESC then id DESC.
		expect(seen).toEqual(
			[...Array(25).keys()].map((index) => idFor(24 - index)),
		);
	});

	it("treats LIKE wildcards in titleContains as literal characters", async () => {
		insert({ id: idFor(1), title: "100% coverage" });
		insert({ id: idFor(2), title: "100 percent coverage" });

		const literal = await listWorkItemsPage(db, {
			orgId: ORG,
			titleContains: "100%",
		});
		expect(literal.total).toBe(1);
		expect(literal.data[0]?.title).toBe("100% coverage");

		const caseInsensitive = await listWorkItemsPage(db, {
			orgId: ORG,
			titleContains: "PERCENT",
		});
		expect(caseInsensitive.total).toBe(1);
	});

	it("never leaks another organization's rows into a filtered count", async () => {
		insert({ id: idFor(1), title: "Shared title" });
		insert({ id: idFor(2), orgId: OTHER_ORG, title: "Shared title" });

		const page = await listWorkItemsPage(db, {
			orgId: ORG,
			titleContains: "Shared title",
		});
		expect(page.total).toBe(1);
		expect(page.data[0]?.orgId).toBe(ORG);
	});
});

describe("customerVisiblePreFilter", () => {
	function seedWithMetadata(id: string, metadata: Record<string, unknown>) {
		sqlite
			.prepare(
				`INSERT INTO work_items (id,org_id,title,disposition,work_kind,created_at,metadata)
				 VALUES (?,?,?,?,?,?,?)`,
			)
			.run(
				id,
				ORG,
				"Seed",
				"proposed",
				"other",
				"2026-08-20T00:00:00.000Z",
				JSON.stringify(metadata),
			);
	}

	/**
	 * The filter exists so a customer board is not paging through factory
	 * records — at low visible density a bounded window finds nothing and
	 * renders "no open work".
	 */
	it("drops agent-session and transitional rows, keeps customer work", async () => {
		seedWithMetadata(idFor(1), { agentSession: "claude-code:abc" });
		seedWithMetadata(idFor(2), { purposeContext: "transitional_repair" });
		seedWithMetadata(idFor(3), {});
		seedWithMetadata(idFor(4), { purposeContext: "customer_request" });

		const page = await listWorkItemsPage(db, {
			orgId: ORG,
			customerVisiblePreFilter: true,
		});
		expect(page.data.map((row) => row.id).sort()).toEqual(
			[idFor(3), idFor(4)].sort(),
		);
		// The count must describe the FILTERED set, not the window.
		expect(page.total).toBe(2);
	});

	/**
	 * `_` is a LIKE wildcard. Unescaped, `transitional_%` also matches
	 * `transitionalX…`, which would silently hide legitimate customer work whose
	 * purpose context merely starts with the same letters.
	 */
	it("does not treat the underscore as a wildcard", async () => {
		seedWithMetadata(idFor(5), { purposeContext: "transitionalXcustomer" });
		const page = await listWorkItemsPage(db, {
			orgId: ORG,
			customerVisiblePreFilter: true,
		});
		expect(page.data.map((row) => row.id)).toContain(idFor(5));
	});

	it("is off by default, so existing callers are unchanged", async () => {
		seedWithMetadata(idFor(6), { agentSession: "claude-code:abc" });
		const page = await listWorkItemsPage(db, { orgId: ORG });
		expect(page.data.map((row) => row.id)).toContain(idFor(6));
	});
});
