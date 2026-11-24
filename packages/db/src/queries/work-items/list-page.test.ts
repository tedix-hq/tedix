import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { workItems, WORK_ITEM_TITLE_SEARCH_DDL } from "../../schema/work-items";
import { createD1Facade } from "../../test/d1-facade";
import { maintainedTotalsDdl } from "../../test/schema-ddl";
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
 parent_work_item_id TEXT, executor_type TEXT, executor_id TEXT, dispatch_state TEXT,
 delegation_depth INTEGER, max_attempts INTEGER, root_work_item_id TEXT, root_goal TEXT, budget_share_micros INTEGER,
 source_session_key TEXT, source_intent_id TEXT,
 due_date TEXT, deadline TEXT, start_at TEXT, duration_days INTEGER, provenance TEXT DEFAULT '{}',
 repository_observer INTEGER GENERATED ALWAYS AS (CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.repositoryObserver') END) VIRTUAL,
 report TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.report') END) VIRTUAL,
 observer_woken_at TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.observerWokenAt') END) VIRTUAL,
 metadata_executor TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.executor') END) VIRTUAL,
 metadata_source TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.source') END) VIRTUAL,
 delegation_root_id TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.childDelegation.rootId') END) VIRTUAL,
 metadata TEXT DEFAULT '{}',
 created_at TEXT NOT NULL, updated_at TEXT, accepted_at TEXT, completed_at TEXT,
 cancelled_at TEXT, version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE work_attempts (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, work_item_id TEXT NOT NULL,
 admission_id TEXT, outcome TEXT, attempt_number INTEGER NOT NULL, finished_at TEXT
);
CREATE TABLE work_admissions (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, work_item_id TEXT NOT NULL,
 work_item_version INTEGER NOT NULL, admission_spec_revision TEXT NOT NULL, decision TEXT NOT NULL
);
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
	accountableOwnerId?: string | null;
	priority?: string;
	dueDate?: string | null;
	deadline?: string | null;
	createdAt?: string;
}) {
	sqlite
		.prepare(
			`INSERT INTO work_items
			 (id,org_id,title,disposition,work_kind,work_class,objective_id,project_id,accountable_owner_type,accountable_owner_id,priority,due_date,deadline,created_at)
			 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
			row.accountableOwnerId ? "tedi" : null,
			row.accountableOwnerId ?? null,
			row.priority ?? "medium",
			row.dueDate ?? null,
			row.deadline ?? null,
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
	// The unfiltered total is read from the trigger-maintained row.
	sqlite.exec(maintainedTotalsDdl(workItems));
	sqlite.exec(WORK_ITEM_TITLE_SEARCH_DDL.join("\n"));
	db = createDbQueryClient(createD1Facade(sqlite));
});

describe("listWorkItemsPage filters and counts in SQL", () => {
	it("distinguishes the local tedi runner from cloud tedi assignments", async () => {
		insert({ id: idFor(1) });
		insert({ id: idFor(2) });
		sqlite
			.prepare(
				"UPDATE work_items SET executor_type = ?, executor_id = ? WHERE id = ?",
			)
			.run("external_agent", "tedi", idFor(1));
		sqlite
			.prepare(
				"UPDATE work_items SET executor_type = ?, executor_id = ? WHERE id = ?",
			)
			.run("tedi", "cloud-agent", idFor(2));
		const local = await listWorkItemsPage(db, {
			orgId: ORG,
			executor: ["codex", "tedi"],
			executorType: "external_agent",
		});
		expect(local.data.map((row) => row.id)).toEqual([idFor(1)]);
		const cloud = await listWorkItemsPage(db, { orgId: ORG, executor: "tedi" });
		expect(cloud.data.map((row) => row.id)).toEqual([idFor(2)]);
	});
	it("keeps substring candidates current after backfill, title edits, moves and deletion", async () => {
		sqlite.exec(`DROP TRIGGER work_item_title_search_insert;
			DROP TRIGGER work_item_title_search_update;
			DROP TRIGGER work_item_title_search_delete;
			DROP TABLE work_item_title_search;`);
		insert({
			id: "match",
			title: 'Before "quoted" 100% café',
			projectId: PROJECT,
		});
		insert({
			id: "other",
			orgId: OTHER_ORG,
			title: 'Before "quoted" 100% café',
		});
		// Found by name: a migration's timestamp changes when it is restamped.
		const migrations = new URL("../../../drizzle/", import.meta.url);
		const migration = readdirSync(migrations).find((name) =>
			name.endsWith("_work_title_search"),
		);
		sqlite.exec(
			readFileSync(new URL(`${migration}/migration.sql`, migrations), "utf8"),
		);
		const search = (titleContains: string) =>
			listWorkItemsPage(db, {
				orgId: ORG,
				projectId: PROJECT,
				titleContains,
			});
		expect(
			(await search('"QUOTED" 100% café')).data.map((row) => row.id),
		).toEqual(["match"]);
		sqlite.exec(
			"UPDATE work_items SET title='After replacement' WHERE id='match'",
		);
		expect((await search('"quoted"')).total).toBe(0);
		expect((await search("replacement")).total).toBe(1);
		sqlite.exec("UPDATE work_items SET project_id=NULL WHERE id='match'");
		expect((await search("replacement")).total).toBe(0);
		sqlite.exec(
			"UPDATE work_items SET org_id='org-2', project_id='project-1' WHERE id='match'",
		);
		expect((await search("replacement")).total).toBe(0);
		sqlite.exec("DELETE FROM work_items WHERE id='match'");
		expect(
			sqlite
				.prepare(
					"SELECT rowid FROM work_item_title_search WHERE work_item_title_search MATCH ?",
				)
				.all('"replacement"'),
		).toEqual([]);
	});

	it("does not dispatch a settled result again until the Work is revised", async () => {
		insert({ id: "work", disposition: "accepted" });
		sqlite.exec(`
			UPDATE work_items SET executor_type='external_agent', executor_id='codex', dispatch_state='ready' WHERE id='work';
			INSERT INTO work_admissions VALUES ('admission','org-1','work',1,'legacy','admitted');
			INSERT INTO work_attempts VALUES ('attempt','org-1','work','admission','succeeded',1,'2026-11-20T00:00:00.000Z');
		`);
		const list = () =>
			listWorkItemsPage(db, {
				orgId: ORG,
				executor: "codex",
				dispatchReadyOnly: true,
			});
		expect((await list()).data).toEqual([]);
		sqlite.exec("UPDATE work_attempts SET outcome='failed' WHERE id='attempt'");
		expect((await list()).data.map((item) => item.id)).toEqual(["work"]);
		sqlite.exec(
			"UPDATE work_attempts SET outcome='landed_unverified' WHERE id='attempt'",
		);
		expect((await list()).data).toEqual([]);
		sqlite.exec(
			`UPDATE work_items SET metadata=json_set(metadata,'$.decisionContinuation.at','2026-11-21T00:00:00.000Z') WHERE id='work'`,
		);
		expect((await list()).data.map((item) => item.id)).toEqual(["work"]);
		sqlite.exec("UPDATE work_items SET metadata='{}' WHERE id='work'");
		sqlite.exec("UPDATE work_items SET version=2 WHERE id='work'");
		expect((await list()).data.map((item) => item.id)).toEqual(["work"]);
	});

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

	it("leaves out one disposition before paging and counts the rest", async () => {
		const dispositions = ["proposed", "accepted", "completed", "cancelled"];
		for (let index = 0; index < 20; index += 1)
			insert({ id: idFor(index), disposition: dispositions[index % 4] });
		const page = await listWorkItemsPage(db, {
			orgId: ORG,
			excludeDisposition: "proposed",
			limit: 5,
		});
		expect(page.total).toBe(15);
		expect(page.data).toHaveLength(5);
		expect(page.data.map((row) => row.disposition)).not.toContain("proposed");
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

	it("matches a title substring longer than D1's 50-byte LIKE pattern cap", async () => {
		// A delegation title is searched for verbatim before it is created; the
		// LIKE this replaced turned any 48+ character search into a D1_ERROR.
		const title =
			"Harden the embedded widget turn pipeline against sponsored-capacity exhaustion";
		insert({ id: idFor(1), title });
		insert({ id: idFor(2), title: "Harden something shorter" });

		const page = await listWorkItemsPage(db, {
			orgId: ORG,
			titleContains: title.toUpperCase().slice(0, 200),
		});
		expect(page.total).toBe(1);
		expect(page.data[0]?.id).toBe(idFor(1));
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

describe("accountableOwnerId and objectiveLinked", () => {
	/**
	 * One owner holds most of an org's accepted work. A page read and then
	 * filtered by owner client-side never reaches anyone else's items, so the
	 * owner filter must select rows before the page is cut.
	 */
	function seedOwners() {
		// 150 newer CTO items fill the first page completely.
		for (let index = 0; index < 150; index += 1) {
			insert({
				id: idFor(1_000 + index),
				disposition: "accepted",
				accountableOwnerId: "tedi-cto",
				objectiveId: OBJECTIVE,
				createdAt: new Date(
					Date.UTC(2026, 5, 1) + index * 60_000,
				).toISOString(),
			});
		}
		// Three older CEO items, one linked to an objective.
		for (let index = 0; index < 3; index += 1) {
			insert({
				id: idFor(index),
				disposition: "accepted",
				accountableOwnerId: "tedi-ceo",
				objectiveId: index === 0 ? OBJECTIVE : null,
				createdAt: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
			});
		}
		insert({
			id: idFor(9_000),
			orgId: OTHER_ORG,
			disposition: "accepted",
			accountableOwnerId: "tedi-ceo",
		});
	}

	it("returns only the owner's items even when 100+ other items come first", async () => {
		seedOwners();
		const page = await listWorkItemsPage(db, {
			orgId: ORG,
			disposition: "accepted",
			accountableOwnerId: "tedi-ceo",
			limit: 100,
		});
		expect(page.total).toBe(3);
		expect(page.data.map((row) => row.id)).toEqual([
			idFor(2),
			idFor(1),
			idFor(0),
		]);
	});

	it("composes the owner filter with objectiveLinked", async () => {
		seedOwners();
		const linked = await listWorkItemsPage(db, {
			orgId: ORG,
			accountableOwnerId: "tedi-ceo",
			objectiveLinked: true,
		});
		expect(linked.data.map((row) => row.id)).toEqual([idFor(0)]);
		const unlinked = await listWorkItemsPage(db, {
			orgId: ORG,
			accountableOwnerId: "tedi-ceo",
			objectiveLinked: false,
		});
		expect(unlinked.total).toBe(2);
	});

	it("leaves the first page unchanged when both filters are omitted", async () => {
		seedOwners();
		const page = await listWorkItemsPage(db, {
			orgId: ORG,
			disposition: "accepted",
			limit: 100,
		});
		expect(page.total).toBe(153);
		expect(page.data).toHaveLength(100);
		expect(
			page.data.every((row) => row.accountableOwnerId === "tedi-cto"),
		).toBe(true);
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
	it("drops agent-session and internal-purpose rows, keeps customer work", async () => {
		seedWithMetadata(idFor(1), { agentSession: "claude-code:abc" });
		seedWithMetadata(idFor(2), {
			purposeContext: "transitional_home_exception",
		});
		seedWithMetadata(idFor(7), {
			purposeContext: "transitional_task_intent_exception",
		});
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
	 * Only the named internal purpose contexts are hidden. A prefix match would
	 * silently hide customer work whose purpose context merely starts with the
	 * same letters.
	 */
	it("matches the internal purpose contexts exactly, not by prefix", async () => {
		seedWithMetadata(idFor(5), { purposeContext: "transitional_customer" });
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

it("filters the executor before pagination and keeps organization scope", async () => {
	for (let n = 0; n < 30; n++)
		insert({ id: idFor(n), disposition: "accepted", projectId: PROJECT });
	sqlite
		.prepare(
			"UPDATE work_items SET metadata = ?, executor_type = 'external_agent', executor_id = 'codex' WHERE id = ?",
		)
		.run(JSON.stringify({ executor: "codex", retained: true }), idFor(0));
	insert({
		id: idFor(100),
		orgId: OTHER_ORG,
		disposition: "accepted",
		projectId: PROJECT,
	});
	sqlite
		.prepare(
			"UPDATE work_items SET metadata = ?, executor_type = 'external_agent', executor_id = 'codex' WHERE id = ?",
		)
		.run(JSON.stringify({ executor: "codex" }), idFor(100));
	const page = await listWorkItemsPage(db, {
		orgId: ORG,
		executor: "codex",
		disposition: "accepted",
		projectId: PROJECT,
		limit: 1,
	});
	expect(page.total).toBe(1);
	expect(page.data.map((row) => row.id)).toEqual([idFor(0)]);
	expect(page.data[0]!.metadata).toMatchObject({ retained: true });
});

it("pages server-selected lanes and keeps held or malformed plans out of dispatch", async () => {
	const plans = [
		undefined,
		{ state: "ready", score: 90 },
		{ state: "held" },
		null,
		{ state: "unknown" },
	];
	for (let n = 0; n < plans.length; n++) {
		insert({ id: idFor(n), disposition: "accepted" });
		sqlite.prepare("UPDATE work_items SET metadata = ? WHERE id = ?").run(
			JSON.stringify({
				executor: "codex",
				...(n === 0 ? {} : { laneDispatch: plans[n] }),
			}),
			idFor(n),
		);
		sqlite
			.prepare(
				"UPDATE work_items SET executor_type = 'external_agent', executor_id = 'codex', dispatch_state = ? WHERE id = ?",
			)
			.run(
				plans[n]?.state === "ready" || plans[n]?.state === "held"
					? plans[n]!.state
					: null,
				idFor(n),
			);
	}
	insert({ id: idFor(100), orgId: OTHER_ORG });
	sqlite
		.prepare(
			"UPDATE work_items SET metadata = ?, executor_type = 'external_agent', executor_id = 'codex', dispatch_state = 'ready' WHERE id = ?",
		)
		.run(
			JSON.stringify({ executor: "codex", laneDispatch: { state: "ready" } }),
			idFor(100),
		);
	const page = await listWorkItemsPage(db, {
		orgId: ORG,
		executor: "codex",
		dispatchReadyOnly: true,
		limit: 1,
	});
	// A missing plan is not ready; only the explicit ready state is.
	expect(page.total).toBe(1);
	expect(page.data.map((r) => r.id)).toEqual([idFor(1)]);
	const second = await listWorkItemsPage(db, {
		orgId: ORG,
		executor: "codex",
		dispatchReadyOnly: true,
		limit: 1,
		offset: 1,
	});
	expect(second.data).toEqual([]);
	expect(
		(await listWorkItemsPage(db, { orgId: ORG, executor: "codex" })).total,
	).toBe(5);
});

it("filters an executor set before pagination and count, preserving org scope", async () => {
	for (const [n, executor] of [
		"codex",
		"claude-code",
		"devin",
		"human",
		"tedi",
	].entries()) {
		insert({ id: idFor(n) });
		sqlite
			.prepare(
				"UPDATE work_items SET metadata=?, executor_type=?, executor_id=? WHERE id=?",
			)
			.run(
				JSON.stringify({ executor }),
				executor === "human" || executor === "tedi"
					? executor
					: "external_agent",
				executor,
				idFor(n),
			);
	}
	insert({ id: idFor(99), orgId: OTHER_ORG });
	sqlite
		.prepare(
			"UPDATE work_items SET metadata=?, executor_type='external_agent', executor_id='codex' WHERE id=?",
		)
		.run(JSON.stringify({ executor: "codex" }), idFor(99));
	const first = await listWorkItemsPage(db, {
		orgId: ORG,
		executor: ["codex", "claude-code", "devin"],
		limit: 2,
	});
	expect(first.total).toBe(3);
	expect(first.data.map((row) => row.id)).toEqual([idFor(2), idFor(1)]);
	const second = await listWorkItemsPage(db, {
		orgId: ORG,
		executor: ["codex", "claude-code", "devin"],
		limit: 2,
		offset: 2,
	});
	expect(second.total).toBe(3);
	expect(second.data.map((row) => row.id)).toEqual([idFor(0)]);
});

it("filters legacy human and tedi categories by executor type", async () => {
	insert({ id: idFor(1) });
	insert({ id: idFor(2) });
	sqlite
		.prepare("UPDATE work_items SET executor_type=?,executor_id=? WHERE id=?")
		.run("human", "person-1", idFor(1));
	sqlite
		.prepare("UPDATE work_items SET executor_type=?,executor_id=? WHERE id=?")
		.run("tedi", "worker-1", idFor(2));
	expect(
		(await listWorkItemsPage(db, { orgId: ORG, executor: "human" })).data.map(
			(row) => row.id,
		),
	).toEqual([idFor(1)]);
	expect(
		(await listWorkItemsPage(db, { orgId: ORG, executor: "tedi" })).data.map(
			(row) => row.id,
		),
	).toEqual([idFor(2)]);
});

it.each([{ executor: [] }, { executor: Array(11).fill("codex") }])(
	"rejects an invalid executor filter size",
	async ({ executor }) => {
		await expect(
			listWorkItemsPage(db, { orgId: ORG, executor }),
		).rejects.toThrow("between 1 and 10");
	},
);

it("selects high-priority and due Work before paging", async () => {
	insert({ id: idFor(1), disposition: "accepted", priority: "high" });
	insert({
		id: idFor(2),
		disposition: "accepted",
		dueDate: "2026-11-20T12:00:00.000Z",
	});
	insert({ id: idFor(3), disposition: "accepted", projectId: PROJECT });
	insert({
		id: idFor(4),
		disposition: "accepted",
		deadline: "2026-12-01T12:00:00.000Z",
	});
	insert({ id: idFor(5), disposition: "completed", priority: "critical" });

	const page = await listWorkItemsPage(db, {
		orgId: ORG,
		disposition: "accepted",
		mattersThrough: "2026-11-22T23:59:59.999Z",
		limit: 1,
	});
	expect(page.total).toBe(2);
	expect(page.data).toHaveLength(1);
	const all = await listWorkItemsPage(db, {
		orgId: ORG,
		disposition: "accepted",
		mattersThrough: "2026-11-22T23:59:59.999Z",
		limit: 10,
	});
	expect(all.data.map((row) => row.id).sort()).toEqual(
		[idFor(1), idFor(2)].sort(),
	);
});
