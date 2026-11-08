import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getMigratedSqliteTemplate } from "../../packages/db/src/test/migrated-sqlite-template";
import { LocalBundleStore } from "./bundle";
import { openStores, parseArgs } from "./cli";
import { checkAssignments, exportAll } from "./export";
import { importAll, importWorkspace } from "./import";
import { reconcileAll } from "./reconcile";
import { proposeAssignments } from "./assignments";
import { rehearse } from "./rehearse";
import { checkSchema, objectSchemaDatabase } from "./schema-check";
import { batchIdFor, RowDigest } from "./rows";
import { Snapshot } from "./source";
import { remoteStoreFactory } from "./target";
import {
	TABLES_THAT_STAY,
	WORKSPACE_TABLES,
	type WorkspaceAssignments,
} from "./tables";
import { LocalWorkspaceStore, localStoreFactory } from "./target";

// Use the shared exact-ledger cache; full migration replay is fixture setup,
// not part of the importer's five-second behavior checks.
const template = getMigratedSqliteTemplate({ foreignKeys: false });

/** A database shaped like the shared one today, from its real migration chain. */
function sharedDatabase(): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	db.deserialize(template);
	db.exec("PRAGMA foreign_keys=OFF");
	return db;
}

const ORG = "org-fixture";
const WS_A = "ws-a";
const WS_B = "ws-b";
const NOW = "2026-11-07T10:00:00.000Z";

/** Two workspaces, one organization, rows in every mapped domain, run events split across stores. */
function fixtureSnapshot(
	options: { unassignedOutput?: boolean } = {},
): Snapshot {
	const main = sharedDatabase();
	const logs = sharedDatabase();
	main.exec(
		`INSERT INTO organizations (id, name, slug) VALUES ('${ORG}', 'Fixture', 'fixture')`,
	);
	for (const ws of [WS_A, WS_B])
		main
			.prepare(
				"INSERT INTO os_workspaces (id, organization_id, name, created_by_kind, created_by_id, created_at) VALUES (?, ?, ?, 'user', 'u1', ?)",
			)
			.run(ws, ORG, ws, NOW);
	const output = main.prepare(
		"INSERT INTO os_outputs (id, organization_id, workspace_id, kind, title, current_revision_id, created_by_kind, created_by_id) VALUES (?, ?, ?, 'document', ?, ?, 'user', 'u1')",
	);
	const revision = main.prepare(
		"INSERT INTO os_output_revisions (id, organization_id, output_id, revision, content, created_by_kind, created_by_id, content_sha256, body_r2_key) VALUES (?, ?, ?, ?, ?, 'user', 'u1', ?, ?)",
	);
	output.run("out-a1", ORG, WS_A, "Plan", "rev-a1-2");
	revision.run("rev-a1-1", ORG, "out-a1", 1, '{"blocks":[]}', null, null);
	revision.run("rev-a1-2", ORG, "out-a1", 2, "", "abc", "outputs/out-a1/2");
	output.run("out-b1", ORG, WS_B, "Sheet", "rev-b1-1");
	revision.run("rev-b1-1", ORG, "out-b1", 1, '{"rows":[[1,2]]}', null, null);
	if (options.unassignedOutput) {
		output.run("out-none", ORG, null, "Loose", "rev-none-1");
		revision.run("rev-none-1", ORG, "out-none", 1, "{}", null, null);
	}
	main
		.prepare(
			"INSERT INTO os_workspace_resources (id, organization_id, workspace_id, provider_id, connection_scope, resource_type, provider_resource_id, name, created_by_kind, created_by_id) VALUES (?, ?, ?, 'gmail', 'tenant', 'mailbox', 'inbox', 'Inbox', 'user', 'u1')",
		)
		.run("res-a", ORG, WS_A);
	main
		.prepare(
			"INSERT INTO kernel_conversations (id, organization_id, conversation_id, workspace_id, last_message_at) VALUES (?, ?, ?, ?, ?)",
		)
		.run("kc-a", ORG, "conv-a", WS_A, NOW);
	main
		.prepare(
			"INSERT INTO kernel_conversations (id, organization_id, conversation_id, workspace_id, last_message_at) VALUES (?, ?, ?, NULL, ?)",
		)
		.run("kc-home", ORG, "conv-home", NOW);
	// Another organization's Home thread reuses the same conversation id as ws-a's thread; its runs stay.
	main
		.prepare(
			"INSERT INTO organizations (id, name, slug) VALUES ('org-other', 'Other', 'other')",
		)
		.run();
	main
		.prepare(
			"INSERT INTO kernel_conversations (id, organization_id, conversation_id, workspace_id, last_message_at) VALUES (?, ?, ?, NULL, ?)",
		)
		.run("kc-other", "org-other", "conv-a", NOW);
	main
		.prepare(
			"INSERT INTO kernel_runtime_runs (id, organization_id, conversation_id, status) VALUES (?, ?, ?, 'completed')",
		)
		.run("run-other", "org-other", "conv-a");
	main
		.prepare(
			"INSERT INTO kernel_runtime_runs (id, organization_id, conversation_id, status) VALUES (?, ?, ?, 'completed')",
		)
		.run("run-a", ORG, "conv-a");
	main
		.prepare(
			"INSERT INTO kernel_runtime_runs (id, organization_id, conversation_id, status) VALUES (?, ?, ?, 'completed')",
		)
		.run("run-home", ORG, "conv-home");
	const event =
		"INSERT INTO kernel_runtime_events (id, organization_id, kind, conversation_id, run_id, sequence, payload) VALUES (?, ?, 'message', ?, ?, ?, ?)";
	main
		.prepare(event)
		.run("ev-1", ORG, "conv-a", "run-a", 1, '{"text":"hello"}');
	main
		.prepare(event)
		.run("ev-2", ORG, "conv-a", "run-a", 2, '{"text":"moved"}');
	logs
		.prepare(
			"INSERT INTO kernel_conversations (id, organization_id, conversation_id, workspace_id, last_message_at) VALUES (?, ?, ?, ?, ?)",
		)
		.run("kc-a", ORG, "conv-a", WS_A, NOW);
	logs
		.prepare(event)
		.run("ev-2", ORG, "conv-a", "run-a", 2, '{"text":"moved"}');
	logs
		.prepare(event)
		.run("ev-3", ORG, "conv-a", "run-a", 3, '{"text":"only in logs"}');
	main
		.prepare(
			"INSERT INTO kernel_tool_results (id, organization_id, conversation_id, run_id, source_kind, source_id, object_key, sha256, byte_size, created_at, expires_at) VALUES (?, ?, ?, ?, 'tool', 't1', 'k/1', 'sha', 10, ?, ?)",
		)
		.run("tr-1", ORG, "conv-a", "run-a", NOW, NOW);
	main
		.prepare(
			"INSERT INTO tedi_artifacts (id, organization_id, tedi_id, conversation_id, run_id, kind, name, metadata) VALUES (?, ?, 'tedi-1', ?, ?, 'file', 'report.pdf', ?)",
		)
		.run("art-1", ORG, "conv-a", "run-a", '{"pages":3}');
	main
		.prepare(
			"INSERT INTO memory_domains (id, organization_id, name) VALUES (?, ?, ?)",
		)
		.run("dom-1", ORG, "product");
	main
		.prepare(
			"INSERT INTO memory_facts (id, organization_id, domain_id, content, fact_type) VALUES (?, ?, ?, ?, 'preference')",
		)
		.run("fact-1", ORG, "dom-1", "Prefers short answers");
	main
		.prepare(
			"INSERT INTO memory_facts (id, organization_id, domain_id, content, fact_type) VALUES (?, ?, ?, ?, 'preference')",
		)
		.run("fact-2", ORG, "dom-1", "Works in EU hours");
	main
		.prepare(
			"INSERT INTO memory_edges (id, source_fact_id, target_fact_id, relation_type) VALUES (?, ?, ?, 'related')",
		)
		.run("edge-1", "fact-1", "fact-2");
	main
		.prepare(
			"INSERT INTO memory_facts (id, organization_id, domain_id, content, fact_type, metadata) VALUES (?, ?, ?, ?, 'preference', ?)",
		)
		.run(
			"fact-3",
			ORG,
			"dom-1",
			"Consolidated",
			'{"consolidation":{"evidence":{"sources":[{"id":"fact-1"},{"id":"fact-2"}]}}}',
		);
	return Snapshot.fromDatabases(main, [logs]);
}

const assignments: WorkspaceAssignments = {
	[ORG]: { memoryHome: WS_A, unassignedOutputsHome: WS_B },
};

describe("migrate-workspaces", () => {
	test("rejects conflicting event copies across the main and log snapshots", () => {
		const snapshot = fixtureSnapshot();
		try {
			const events = WORKSPACE_TABLES.find(
				(mapping) => mapping.table === "kernel_runtime_events",
			)!;
			const ref = { organizationId: ORG, workspaceId: WS_A };
			expect(snapshot.readRows(events, ref)).toHaveLength(3);
			snapshot.logs[0]!.prepare(
				"UPDATE kernel_runtime_events SET payload = ? WHERE id = ?",
			).run('{"text":"different"}', "ev-2");
			expect(() => snapshot.readRows(events, ref)).toThrow(
				"Conflicting duplicate rows in kernel_runtime_events across snapshot stores",
			);
		} finally {
			snapshot.close();
		}
	});

	test("blocks remote imports before contacting a target in either authentication mode", async () => {
		const ref = { organizationId: ORG, workspaceId: WS_A };
		const bundles = new LocalBundleStore("unused-remote-import-bundles");
		let requests = 0;
		const fetchImplementation = Object.assign(
			async () => {
				requests += 1;
				throw new Error("remote import contacted the target");
			},
			{ preconnect: fetch.preconnect },
		);
		for (const auth of [
			"object-token",
			{ mode: "tedix" as const, headers: async () => ({}) },
		]) {
			const stores = remoteStoreFactory(
				"https://objects.example",
				auth,
				fetchImplementation,
			);
			await expect(importWorkspace(bundles, stores, ref)).rejects.toThrow(
				"Remote workspace import is blocked",
			);
			await expect(
				importAll(
					{
						read: bundles.read.bind(bundles),
						write: bundles.write.bind(bundles),
						list: async () => [ref],
					},
					stores,
				),
			).rejects.toThrow("Remote workspace import is blocked");
		}
		expect(requests).toBe(0);
	});

	test.each([
		"visibility",
		"tedi_id",
		"memory_scope",
		"use_policy",
		"organization_id",
		"missing-summary",
		"missing-rows",
		"derived-citation",
		"reassigned",
		"unmapped",
	])("rejects bundle damage before opening a target: %s", async (damage) => {
		const snapshot = fixtureSnapshot();
		const workDir = mkdtempSync(join(tmpdir(), "mw-preflight-"));
		try {
			const bundles = new LocalBundleStore(join(workDir, "bundles"));
			await exportAll(snapshot, bundles, assignments);
			const ref = { organizationId: ORG, workspaceId: WS_A };
			const { manifest, tables } = await bundles.read(ref);
			if (damage === "missing-summary") delete manifest.tables.memory_facts;
			else if (damage === "missing-rows") tables.delete("memory_facts");
			else if (damage === "derived-citation")
				tables.get("memory_fact_citations")!.pop();
			else if (damage === "reassigned")
				manifest.tables.memory_facts!.reassigned = 1;
			else if (damage === "unmapped") tables.set("unmapped_memory", []);
			else tables.get("memory_facts")![0]![damage] = "changed-policy";
			let opens = 0;
			await expect(
				importWorkspace(
					{
						write: bundles.write.bind(bundles),
						list: bundles.list.bind(bundles),
						read: async () => ({ manifest, tables }),
					},
					{
						kind: "local",
						open: async () => {
							opens += 1;
							throw new Error("target opened");
						},
					},
					ref,
				),
			).rejects.toThrow(/bundle/);
			expect(opens).toBe(0);
		} finally {
			snapshot.close();
			rmSync(workDir, { recursive: true, force: true });
		}
	});

	test("rehearsal moves every workspace with zero drift and reports timings", async () => {
		const snapshot = fixtureSnapshot();
		const workDir = mkdtempSync(join(tmpdir(), "mw-test-"));
		try {
			const report = await rehearse(snapshot, assignments, { workDir });
			expect(report.reconcile.problems).toEqual([]);
			expect(
				report.reconcile.workspaces.flatMap((w) => [...w.drift, ...w.problems]),
			).toEqual([]);
			expect(report.ok).toBe(true);
			expect(report.workspaces.map((w) => w.workspaceId)).toEqual([WS_A, WS_B]);
			for (const w of report.workspaces) {
				expect(w.exportMs).toBeGreaterThan(0);
				expect(w.importMs).toBeGreaterThan(0);
				expect(w.reconcileMs).toBeGreaterThan(0);
			}
			const a = report.workspaces.find((w) => w.workspaceId === WS_A)!;
			// outputs 1 + revisions 2 + resource 1 + conversation 1 + run 1 + events 3 (one only in the log partition, one in both) + tool result 1 + artifact 1 + memory 7 (one domain, three facts, one edge, two citations the object derives itself) + the workspace's own directory row
			expect(a.rows).toBe(19);
			const totals = Object.fromEntries(
				report.reconcile.totals.map((t) => [t.table, t]),
			);
			expect(totals.kernel_runtime_events).toEqual({
				table: "kernel_runtime_events",
				source: 3,
				bundled: 3,
				staying: 0,
			});
			// Home threads and their runs stay in the core: not bundled, not counted as left behind.
			expect(totals.kernel_conversations!.bundled).toBe(1);
			expect(
				report.reconcile.workspaces.every((w) => w.jurisdiction === "eu"),
			).toBe(true);
			// Output and memory tables now come from the object's migration chain.
			expect(report.fallbackTables).not.toContain("os_outputs");
			expect(report.fallbackTables).not.toContain("memory_facts");
			const bundle = await new LocalBundleStore(join(workDir, "bundles")).read({
				organizationId: ORG,
				workspaceId: WS_A,
			});
			expect(bundle.manifest.outputHeads).toEqual([
				{
					outputId: "out-a1",
					currentRevisionId: "rev-a1-2",
					latestRevision: 2,
				},
			]);
			expect(
				bundle.tables.get("kernel_runtime_events")!.map((r) => r.id),
			).toEqual(["ev-1", "ev-2", "ev-3"]);
		} finally {
			rmSync(workDir, { recursive: true, force: true });
			snapshot.close();
		}
	});

	test("the reconciler reports drift when the object differs from the bundle", async () => {
		const snapshot = fixtureSnapshot();
		const workDir = mkdtempSync(join(tmpdir(), "mw-test-"));
		try {
			const report = await rehearse(snapshot, assignments, { workDir });
			expect(report.ok).toBe(true);
			const stores = localStoreFactory(join(workDir, "objects"));
			const store = (await stores.open({
				organizationId: ORG,
				workspaceId: WS_A,
			})) as LocalWorkspaceStore;
			store.db.exec(
				"UPDATE kernel_runtime_events SET payload = '{\"text\":\"edited\"}' WHERE id = 'ev-1'",
			);
			store.db.exec("DELETE FROM tedi_artifacts");
			store.db.exec("UPDATE os_outputs SET current_revision_id = 'rev-a1-1'");
			await store.close();
			const again = await reconcileAll(
				new LocalBundleStore(join(workDir, "bundles")),
				stores,
				{ snapshot },
			);
			expect(again.ok).toBe(false);
			const a = again.workspaces.find((w) => w.workspaceId === WS_A)!;
			expect(
				a.drift.map((d) => `${d.table}:${d.expectedCount}->${d.actualCount}`),
			).toEqual([
				"os_outputs:1->1",
				"kernel_runtime_events:3->3",
				"tedi_artifacts:1->0",
			]);
			expect(a.problems).toEqual([
				"output out-a1 serves rev-a1-1, expected rev-a1-2",
			]);
			expect(again.workspaces.find((w) => w.workspaceId === WS_B)!.ok).toBe(
				true,
			);
		} finally {
			rmSync(workDir, { recursive: true, force: true });
			snapshot.close();
		}
	});

	test("a wrong jurisdiction is drift", async () => {
		const snapshot = fixtureSnapshot();
		const workDir = mkdtempSync(join(tmpdir(), "mw-test-"));
		try {
			const bundles = new LocalBundleStore(join(workDir, "bundles"));
			await exportAll(snapshot, bundles, assignments);
			const fallbackDdl = (table: string) =>
				String(
					snapshot.main
						.prepare("SELECT sql FROM sqlite_master WHERE name = ?")
						.get(table)?.sql ?? "",
				) || null;
			const stores = localStoreFactory(join(workDir, "objects"), {
				jurisdiction: null,
				fallbackDdl,
			});
			await importAll(bundles, stores);
			const report = await reconcileAll(bundles, stores);
			expect(report.ok).toBe(false);
			expect(report.workspaces[0]!.problems).toEqual([
				"jurisdiction is unset, expected eu",
			]);
			expect(
				(await reconcileAll(bundles, stores, { requiredJurisdiction: null }))
					.ok,
			).toBe(true);
		} finally {
			rmSync(workDir, { recursive: true, force: true });
			snapshot.close();
		}
	});

	test("a rerun of import skips chunks that already landed", async () => {
		const snapshot = fixtureSnapshot();
		const workDir = mkdtempSync(join(tmpdir(), "mw-test-"));
		try {
			const bundles = new LocalBundleStore(join(workDir, "bundles"));
			await exportAll(snapshot, bundles, assignments);
			const fallbackDdl = (table: string) =>
				String(
					snapshot.main
						.prepare("SELECT sql FROM sqlite_master WHERE name = ?")
						.get(table)?.sql ?? "",
				) || null;
			const stores = localStoreFactory(join(workDir, "objects"), {
				fallbackDdl,
			});
			const first = await importAll(bundles, stores);
			const second = await importAll(bundles, stores);
			expect(first.map((r) => r.imported)).toEqual([17, 3]);
			expect(second.map((r) => [r.imported, r.duplicates])).toEqual([
				[0, 17],
				[0, 3],
			]);
			expect((await reconcileAll(bundles, stores, { snapshot })).ok).toBe(true);
			expect(batchIdFor(WS_A, "os_outputs", 0)).toBe(
				batchIdFor(WS_A, "os_outputs", 0),
			);
			expect(batchIdFor(WS_A, "os_outputs", 0)).not.toBe(
				batchIdFor(WS_B, "os_outputs", 0),
			);
		} finally {
			rmSync(workDir, { recursive: true, force: true });
			snapshot.close();
		}
	});

	test("outputs without a workspace need a home, then move with their revisions", async () => {
		const snapshot = fixtureSnapshot({ unassignedOutput: true });
		const workDir = mkdtempSync(join(tmpdir(), "mw-test-"));
		try {
			expect(
				checkAssignments(snapshot, { [ORG]: { memoryHome: WS_A } }),
			).toEqual([
				`organization ${ORG}: 1 outputs have no workspace and no unassignedOutputsHome`,
			]);
			expect(checkAssignments(snapshot, {})).toEqual([
				`organization ${ORG}: 1 outputs have no workspace and no unassignedOutputsHome`,
				`organization ${ORG}: memory rows exist and no memoryHome is assigned`,
			]);
			expect(
				checkAssignments(snapshot, {
					[ORG]: { memoryHome: "nope", unassignedOutputsHome: WS_B },
				}),
			).toEqual([
				`organization ${ORG}: memoryHome nope is not a workspace of that organization`,
			]);
			await expect(
				exportAll(snapshot, new LocalBundleStore(join(workDir, "x")), {}),
			).rejects.toThrow("Export refused");
			const report = await rehearse(snapshot, assignments, { workDir });
			expect(report.ok).toBe(true);
			const bundle = await new LocalBundleStore(join(workDir, "bundles")).read({
				organizationId: ORG,
				workspaceId: WS_B,
			});
			expect(bundle.manifest.tables.os_outputs).toMatchObject({
				count: 2,
				reassigned: 1,
			});
			expect(
				bundle.tables.get("os_outputs")!.find((r) => r.id === "out-none")!
					.workspace_id,
			).toBe(WS_B);
			expect(bundle.manifest.tables.os_output_revisions).toMatchObject({
				count: 2,
				reassigned: 1,
			});
		} finally {
			rmSync(workDir, { recursive: true, force: true });
			snapshot.close();
		}
	});

	test("schema check accepts every mapped table and reports missing tables and columns", () => {
		const snapshot = fixtureSnapshot();
		const object = objectSchemaDatabase();
		try {
			const report = checkSchema(snapshot, object);
			// The object's chain creates every mapped table with the snapshot's columns.
			expect(report.findings).toEqual([]);
			expect(report.ok).toBe(true);
			expect(report.checked.map((c) => c.table).sort()).toEqual(
				WORKSPACE_TABLES.map((m) => m.table).sort(),
			);
			object.exec("DROP TABLE os_outputs");
			expect(checkSchema(snapshot, object).findings).toContainEqual({
				table: "os_outputs",
				kind: "missing-in-object",
				detail: "the object's migration chain does not create it",
			});
			const stripped = sharedDatabase();
			// Keep the search view valid when modelling a snapshot without summary.
			const view = stripped
				.prepare(
					"SELECT sql FROM sqlite_schema WHERE name = 'memory_fact_search_documents'",
				)
				.get() as { sql: string };
			stripped.exec("DROP VIEW memory_fact_search_documents");
			stripped.exec(view.sql.replaceAll("f.summary", "NULL"));
			stripped.exec("ALTER TABLE memory_facts DROP COLUMN summary");
			const findings = checkSchema(Snapshot.fromDatabases(stripped)).findings;
			expect(
				findings.find((f) => f.table === "memory_facts")?.detail,
			).toContain("only in object: [summary]");
		} finally {
			object.close();
			snapshot.close();
		}
	});

	test("assignments proposes the oldest workspace as home, a new Home for a live organization without one, and leaves deleted organizations' rows behind", async () => {
		const snapshot = fixtureSnapshot({ unassignedOutput: true });
		snapshot.main.exec(
			"INSERT INTO organizations (id, name, slug) VALUES ('org-live-no-ws', 'Live', 'live')",
		);
		snapshot.main.exec(
			"INSERT INTO memory_domains (id, organization_id, name) VALUES ('dom-live', 'org-live-no-ws', 'x')",
		);
		snapshot.main.exec(
			"INSERT INTO memory_facts (id, organization_id, domain_id, content, fact_type) VALUES ('fact-live', 'org-live-no-ws', 'dom-live', 'kept', 'preference')",
		);
		snapshot.main.exec(
			"INSERT INTO memory_facts (id, organization_id, content, fact_type) VALUES ('fact-orphan', 'org-deleted', 'orphan', 'preference')",
		);
		const workDir = mkdtempSync(join(tmpdir(), "mw-test-"));
		try {
			const proposal = proposeAssignments(snapshot);
			expect(proposal).toEqual({
				assignments: {
					[ORG]: { memoryHome: WS_A, unassignedOutputsHome: WS_A },
					"org-live-no-ws": {
						memoryHome: "home-org-live-no-ws",
						unassignedOutputsHome: "home-org-live-no-ws",
						createHome: true,
					},
				},
				withoutWorkspace: ["org-live-no-ws"],
				orphaned: ["org-deleted"],
			});
			const withHome = {
				...assignments,
				"org-live-no-ws": proposal.assignments["org-live-no-ws"]!,
			};
			expect(checkAssignments(snapshot, withHome)).toEqual([]);
			const report = await rehearse(snapshot, withHome, { workDir });
			expect(report.reconcile.problems).toEqual([]);
			expect(
				report.reconcile.workspaces.flatMap((w) => [
					...w.drift.map((d) => `${w.workspaceId} ${d.table}`),
					...w.problems,
				]),
			).toEqual([]);
			expect(report.ok).toBe(true);
			expect(report.workspaces.map((w) => w.workspaceId)).toEqual([
				WS_A,
				WS_B,
				"home-org-live-no-ws",
			]);
			const totals = Object.fromEntries(
				report.reconcile.totals.map((t) => [t.table, t]),
			);
			expect(totals.os_workspaces).toMatchObject({ source: 3, bundled: 3 });
			expect(totals.memory_facts).toMatchObject({
				source: 4,
				bundled: 4,
				staying: 1,
			});
			const home = await new LocalBundleStore(join(workDir, "bundles")).read({
				organizationId: "org-live-no-ws",
				workspaceId: "home-org-live-no-ws",
			});
			expect(
				home.tables.get("os_workspaces")!.map((r) => [r.id, r.name]),
			).toEqual([["home-org-live-no-ws", "Home"]]);
			expect(home.tables.get("memory_facts")!.map((r) => r.id)).toEqual([
				"fact-live",
			]);
		} finally {
			rmSync(workDir, { recursive: true, force: true });
			snapshot.close();
		}
	});

	test("the digest orders rows by key and columns by name, and sees blobs", () => {
		const a = new RowDigest(["id"]);
		a.add({ id: "2", v: 1, b: new Uint8Array([1, 2]) });
		a.add({ id: "1", v: null });
		const b = new RowDigest(["id"]);
		b.add({ v: null, id: "1" });
		b.add({ b: new Uint8Array([1, 2]), v: 1, id: "2" });
		expect(a.hex()).toBe(b.hex());
		const c = new RowDigest(["id"]);
		c.add({ id: "1", v: null });
		c.add({ id: "2", v: 1, b: new Uint8Array([1, 3]) });
		expect(c.hex()).not.toBe(a.hex());
		const d = new RowDigest(["id"]);
		d.add({ id: "1", v: "1" });
		const e = new RowDigest(["id"]);
		e.add({ id: "1", v: 1 });
		expect(d.hex()).not.toBe(e.hex());
	});

	test("the mapping names every moved table once and the stay list does not overlap", () => {
		const names = WORKSPACE_TABLES.map((m) => m.table);
		expect(new Set(names).size).toBe(names.length);
		for (const stay of TABLES_THAT_STAY)
			if (!stay.table.includes("(")) expect(names).not.toContain(stay.table);
		for (const mapping of WORKSPACE_TABLES)
			expect(mapping.where).toContain(":org");
	});

	test("the command line takes repeated log partitions", () => {
		expect(
			parseArgs([
				"export",
				"--snapshot",
				"main.sql",
				"--logs",
				"a.sql",
				"b.sql",
				"--bundles",
				"out",
			]),
		).toEqual({
			command: "export",
			flags: { snapshot: "main.sql", logs: ["a.sql", "b.sql"], bundles: "out" },
		});
		expect(
			parseArgs([
				"reconcile",
				"--bundles",
				"b",
				"--remote",
				"https://example.test",
				"--allow-any-jurisdiction",
			]).flags["allow-any-jurisdiction"],
		).toBe(true);
	});
});

describe("remote store authentication modes", () => {
	const ref = { organizationId: "org_1", workspaceId: "ws-1" };
	function capture() {
		const calls: Array<{
			url: string;
			headers: Record<string, string>;
			method: string;
		}> = [];
		const fetchImplementation = (async (
			input: string | URL | Request,
			init?: RequestInit,
		) => {
			calls.push({
				url: String(input),
				headers: Object.fromEntries(new Headers(init?.headers).entries()),
				method: init?.method ?? "GET",
			});
			return Response.json({
				rows: [],
				next: null,
				organizationId: ref.organizationId,
			});
		}) as typeof fetch;
		return { calls, fetchImplementation };
	}

	test("bearer mode talks to the hosting worker directly with the objects' token", async () => {
		const { calls, fetchImplementation } = capture();
		const store = await remoteStoreFactory(
			"https://objects.example/",
			"object-token",
			fetchImplementation,
		).open(ref);
		await store.describe();
		expect(calls[0]?.url).toBe(
			"https://objects.example/migration/workspaces/org_1/ws-1",
		);
		expect(calls[0]?.headers.authorization).toBe("Bearer object-token");
	});

	test("tedix mode goes through the gateway's admin door with the login headers", async () => {
		const { calls, fetchImplementation } = capture();
		const store = await remoteStoreFactory(
			"https://tedix.mcp.example",
			{
				mode: "tedix",
				headers: async () => ({ authorization: "Bearer login-token" }),
			},
			fetchImplementation,
		).open(ref);
		await store.readRows("os_outputs", null, 10);
		expect(calls[0]?.url).toBe(
			"https://tedix.mcp.example/admin/migration/workspaces/org_1/ws-1/rows",
		);
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.headers.authorization).toBe("Bearer login-token");
		expect(calls[0]?.headers["content-type"]).toBe("application/json");
	});

	test("openStores refuses an unknown --auth mode", async () => {
		const { flags } = parseArgs([
			"import",
			"--bundles",
			"b",
			"--remote",
			"https://x",
			"--auth",
			"magic",
		]);
		await expect(openStores(flags, {})).rejects.toThrow(
			'--auth must be "bearer" or "tedix"',
		);
	});
});
