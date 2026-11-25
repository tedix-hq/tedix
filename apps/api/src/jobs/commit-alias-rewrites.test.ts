import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { workItems, workAttempts } from "@tedix/db/schema/work-items";
import { kernelRequests } from "@tedix/db/schema/kernel-requests";
import { auditEvents } from "@tedix/db/schema/audit-events";
import type {
	CommitAliasCountCursor,
	CommitAliasRewriteInput,
} from "@tedix/api-contract/schemas/commit-alias-counts";
import { countCommitAliasPage } from "./commit-alias-counts";
import { rewriteCommitAliasPage } from "./commit-alias-rewrites";

const old = "a".repeat(40),
	canonical = "b".repeat(40),
	dropped = "c".repeat(40);
const repository = "example/project";
const actor = { actorId: "operator", actorType: "external_agent" };
const input = { repository, quietHoursUtc: { start: 1, end: 5 } };
const databases: DatabaseSync[] = [];
function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec("PRAGMA foreign_keys=OFF");
	for (const table of [workItems, workAttempts, kernelRequests, auditEvents])
		sqlite.exec(schemaDdl(table));
	sqlite.exec(`
		CREATE TABLE git_commit_aliases(old_sha TEXT PRIMARY KEY, new_sha TEXT, repository TEXT);
		CREATE TABLE external_agent_attributions(id TEXT PRIMARY KEY, target_id TEXT, target_type TEXT);
		CREATE TABLE external_agent_review_evidence(id TEXT PRIMARY KEY, target_id TEXT, repository_version TEXT);
		CREATE TABLE learning_interaction_events(id TEXT PRIMARY KEY, metadata TEXT);
		CREATE TABLE work_interactions(id TEXT PRIMARY KEY, metadata TEXT, status TEXT);
		CREATE TABLE work_item_comments(id TEXT PRIMARY KEY, metadata TEXT);
		CREATE TABLE work_interaction_card_revisions(id TEXT PRIMARY KEY, proposal TEXT);
		CREATE TABLE tedis(id TEXT, organization_id TEXT, retired_at TEXT);
		CREATE TABLE external_agent_sessions(id TEXT, organization_id TEXT, principal_id TEXT, external_session_key TEXT, status TEXT);
		CREATE TABLE external_agent_principals(id TEXT, organization_id TEXT, status TEXT);
	`);
	const migration = readFileSync(
		new URL(
			"../../../../packages/db/drizzle/20261122133543_normalize_work_attempt_settlement/migration.sql",
			import.meta.url,
		),
		"utf8",
	);
	sqlite.exec(
		migration.slice(
			migration.indexOf("CREATE TRIGGER `work_attempt_admission_update_guard`"),
		),
	);
	const insert = sqlite.prepare(
		"INSERT INTO git_commit_aliases VALUES (?, ?, ?)",
	);
	insert.run(old, canonical, repository);
	insert.run(dropped, "0".repeat(40), repository);
	const batches: number[] = [];
	const facade = createD1Facade(sqlite);
	const batch = facade.batch.bind(facade);
	vi.spyOn(facade, "batch").mockImplementation((statements) => {
		batches.push(statements.length);
		return batch(statements);
	});
	return { sqlite, facade, db: createDbClient(facade), batches };
}
function work(sqlite: DatabaseSync, id: string, metadata: unknown) {
	sqlite
		.prepare(
			"INSERT INTO work_items(id,org_id,title,metadata,created_at) VALUES (?,'org','Example',?,'2026-01-01')",
		)
		.run(id, JSON.stringify(metadata));
}
async function rewrite(
	db: ReturnType<typeof createDbClient>,
	cursor?: CommitAliasRewriteInput["cursor"],
	dryRun = false,
) {
	const pending = rewriteCommitAliasPage(
		db,
		{ ...input, cursor, dryRun },
		actor,
	);
	const assertion = pending.then(
		(value) => ({ value }),
		(error: unknown) => ({ error }),
	);
	await vi.runAllTimersAsync();
	const result = await assertion;
	if ("error" in result) throw result.error;
	return result.value;
}
async function inventory(db: ReturnType<typeof createDbClient>) {
	const counts = [];
	let cursor: CommitAliasCountCursor | undefined;
	do {
		const pending = countCommitAliasPage(db, { ...input, cursor });
		await vi.runAllTimersAsync();
		const page = await pending;
		counts.push([page.location, page.scanned, page.locked, page.unlocked]);
		cursor = page.cursor ?? undefined;
	} while (cursor);
	return counts;
}
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const db of databases.splice(0)) db.close();
});

it("matches inventory in dry run, preserves locked/dropped/free-text fields, resumes pages, and audits each changed row once", async () => {
	vi.useFakeTimers();
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "info").mockImplementation(() => {});
	const f = fixture();
	for (let i = 0; i < 201; i++)
		work(f.sqlite, String(i).padStart(3, "0"), {
			repositoryObserver: true,
			event: {
				sha: old,
				beforeSha: dropped,
				commitShas: [old.toUpperCase(), dropped],
			},
			note: old,
		});
	work(f.sqlite, "ordinary", { event: { sha: old } });
	work(f.sqlite, "dropped", {
		repositoryObserver: true,
		event: { sha: dropped },
	});
	f.sqlite
		.prepare(
			"INSERT INTO work_attempts(id,org_id,work_item_id,executor_type,executor_id,runtime_state,outcome,attempt_number,started_at,heartbeat_at,expires_at,finished_at,metadata) VALUES (?,'org','000','human','person',?,?,?,'2026-01-01','2026-01-01',?,?,?)",
		)
		.run(
			"active",
			"running",
			null,
			1,
			"2099-01-01",
			null,
			JSON.stringify({
				settlement: {
					commitSha: old,
					baseCommit: old,
					runCommitSha: old,
					commitShas: [old],
				},
				commitShas: [old],
				commits: [{ sha: old }],
				sourceCommit: old,
				commitSha: old,
				repositoryLifecycle: { merge: { commitSha: old } },
				cliRelease: { commitSha: old },
				laneResult: { commitSha: old },
				recoveredCommits: [{ commitSha: old }],
				note: old,
			}),
		);
	f.sqlite
		.prepare(
			"INSERT INTO work_attempts(id,org_id,work_item_id,executor_type,executor_id,runtime_state,outcome,attempt_number,started_at,heartbeat_at,finished_at,metadata) VALUES ('finished','org','000','human','person','finished','succeeded',2,'2026-01-01','2026-01-01','2026-01-01',?)",
		)
		.run(JSON.stringify({ commitSha: old }));
	for (const table of ["learning_interaction_events", "work_item_comments"])
		f.sqlite
			.prepare(`INSERT INTO ${table} VALUES ('locked', ?)`)
			.run(JSON.stringify({ commitSha: old, commitShas: [old] }));
	f.sqlite
		.prepare("INSERT INTO work_interactions VALUES ('locked',?,'open')")
		.run(JSON.stringify({ decisionDeck: { effect: { commitSha: old } } }));
	f.sqlite
		.prepare("INSERT INTO work_interaction_card_revisions VALUES ('locked',?)")
		.run(JSON.stringify({ commitSha: old }));
	f.sqlite
		.prepare(
			"INSERT INTO kernel_requests(id,organization_id,owner_user_id,source_kind,source_id,snapshot,next_owner,next_action,last_event_id,created_at,updated_at) VALUES ('kernel','org','person','home','source',?,'person','review','event','2026-01-01','2026-01-01')",
		)
		.run(
			JSON.stringify({
				checks: [{ commitSha: old, baseSha: old }],
				observations: [{ observedVersion: old }],
				note: old,
			}),
		);
	const before = await inventory(f.db);
	const dry = [];
	let cursor: CommitAliasRewriteInput["cursor"];
	do {
		const page = await rewrite(f.db, cursor, true);
		if (page.locationComplete)
			dry.push([page.location, page.scanned, page.locked, page.unlocked]);
		expect(page.changed).toBe(0);
		cursor = page.cursor ?? undefined;
	} while (cursor);
	// Inventory emits two observer pages; compare final location totals.
	expect(dry).toEqual(before.filter((row, i) => before[i + 1]?.[0] !== row[0]));
	expect(
		f.sqlite.prepare("SELECT count(*) AS n FROM audit_events").get(),
	).toEqual({ n: 0 });
	let changed = 0;
	do {
		const page = await rewrite(f.db, cursor);
		changed += page.changed;
		cursor = page.cursor ?? undefined;
	} while (cursor);
	expect(changed).toBe(203);
	expect(f.batches.every((n) => n <= 8)).toBe(true);
	expect(
		f.sqlite.prepare("SELECT count(*) AS n FROM audit_events").get(),
	).toEqual({ n: 203 });
	const row = f.sqlite
		.prepare("SELECT metadata,version FROM work_items WHERE id='000'")
		.get() as { metadata: string; version: number };
	expect(JSON.parse(row.metadata)).toEqual({
		repositoryObserver: true,
		event: {
			sha: canonical,
			beforeSha: dropped,
			commitShas: [canonical, dropped],
		},
		note: old,
	});
	expect(row.version).toBe(2);
	const attempt = f.sqlite
		.prepare("SELECT metadata,version FROM work_attempts WHERE id='active'")
		.get() as { metadata: string; version: number };
	expect(attempt.version).toBe(2);
	expect(JSON.parse(attempt.metadata).note).toBe(old);
	expect(attempt.metadata.match(new RegExp(canonical, "g"))).toHaveLength(12);
	expect(
		f.sqlite
			.prepare("SELECT metadata FROM work_attempts WHERE id='finished'")
			.get(),
	).toEqual({ metadata: JSON.stringify({ commitSha: old }) });
	const after = await inventory(f.db);
	expect(after.map((row) => [row[0], row[2]])).toEqual(
		before.map((row) => [row[0], row[2]]),
	);
	expect(after.find((row) => row[0] === "work_attempts.metadata")?.[3]).toBe(0);
	expect(
		f.sqlite.prepare("SELECT version FROM work_items WHERE id='dropped'").get(),
	).toEqual({ version: 1 });
	// Dropped aliases remain visible to the unchanged inventory, as required.
	expect(after.find((row) => row[0] === "work_items.metadata")?.[3]).toBe(200);
	const audit = f.sqlite
		.prepare("SELECT actor_id,actor_type,metadata FROM audit_events LIMIT 1")
		.get() as { actor_id: string; actor_type: string; metadata: string };
	expect(audit).toMatchObject({
		actor_id: "operator",
		actor_type: "external_agent",
	});
	expect(JSON.parse(audit.metadata)).toMatchObject({
		repository,
		changes: expect.arrayContaining([{ from: old, to: canonical }]),
	});
	const replay = await rewrite(f.db);
	expect(replay.changed).toBe(0);
	expect(
		f.sqlite.prepare("SELECT count(*) AS n FROM audit_events").get(),
	).toEqual({ n: 203 });
});

it("stops at a D1 refusal and rolls back its audit and update together", async () => {
	vi.useFakeTimers();
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "info").mockImplementation(() => {});
	const f = fixture();
	work(f.sqlite, "observer", { repositoryObserver: true, event: { sha: old } });
	f.sqlite.exec(
		"CREATE TRIGGER refuse_rewrite BEFORE UPDATE ON work_items BEGIN SELECT RAISE(ABORT,'D1_ERROR: overloaded'); END",
	);
	const first = await rewrite(f.db);
	await expect(rewrite(f.db, first.cursor!)).rejects.toThrow(/overloaded/);
	expect(f.batches).toEqual([2]);
	expect(
		f.sqlite.prepare("SELECT count(*) AS n FROM audit_events").get(),
	).toEqual({ n: 0 });
	expect(f.sqlite.prepare("SELECT version FROM work_items").get()).toEqual({
		version: 1,
	});
});

it("stops on a concurrent metadata change without overwriting or auditing it", async () => {
	vi.useFakeTimers();
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "info").mockImplementation(() => {});
	const f = fixture();
	work(f.sqlite, "observer", { repositoryObserver: true, event: { sha: old } });
	const first = await rewrite(f.db);
	const batch = vi.mocked(f.facade.batch).getMockImplementation()!;
	vi.mocked(f.facade.batch).mockImplementationOnce((statements) => {
		f.sqlite
			.prepare(
				"UPDATE work_items SET metadata=?,version=version+1 WHERE id='observer'",
			)
			.run(
				JSON.stringify({
					repositoryObserver: true,
					event: { sha: old },
					note: "concurrent edit",
				}),
			);
		return batch(statements);
	});
	await expect(rewrite(f.db, first.cursor!)).rejects.toThrow(/CAS conflict/);
	expect(
		f.sqlite.prepare("SELECT count(*) AS n FROM audit_events").get(),
	).toEqual({ n: 0 });
	const resumed = await rewrite(f.db, first.cursor!);
	expect(resumed.changed).toBe(1);
	const row = f.sqlite
		.prepare("SELECT metadata,version FROM work_items WHERE id='observer'")
		.get() as { metadata: string; version: number };
	expect(JSON.parse(row.metadata)).toMatchObject({
		event: { sha: canonical },
		note: "concurrent edit",
	});
	expect(row.version).toBe(3);
});
