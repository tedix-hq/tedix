import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getMigratedSqliteTemplate } from "../../packages/db/src/test/migrated-sqlite-template";
import { LocalBundleStore } from "./bundle";
import { main, openStores, parseArgs } from "./cli";
import { checkAssignments, exportAll } from "./export";
import { importAll, proveSnapshot } from "./import";
import { applyDeltaAll } from "./delta";
import { reconcileAll } from "./reconcile";
import { proposeAssignments } from "./assignments";
import { rehearse } from "./rehearse";
import { checkSchema, objectSchemaDatabase } from "./schema-check";
import {
	batchIdFor,
	fromWire,
	RowDigest,
	splitSqlStatements,
	toWire,
	type WireRow,
} from "./rows";
import { Scope } from "./scope";
import { SNAPSHOT_MAX_AGE_MS } from "./snapshot-proof";
import { Snapshot } from "./source";
import { remoteStoreFactory } from "./target";
import {
	TABLES_THAT_STAY,
	WORKSPACE_TABLES,
	type WorkspaceAssignments,
} from "./tables";
import {
	LocalWorkspaceStore,
	localStoreFactory,
	readTenantStoreMigrations,
	type WorkspaceStoreFactory,
} from "./target";

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
	options: {
		unassignedOutput?: boolean;
		/** The log partition's own range; none means it holds all dates. */
		partition?: { fromTs: string; toTs?: string; state?: string };
		takenAt?: Date;
	} = {},
): Snapshot {
	const main = sharedDatabase();
	const logs = sharedDatabase();
	logs.exec(
		"CREATE TABLE IF NOT EXISTS log_partition (id text PRIMARY KEY NOT NULL, state text NOT NULL, from_ts text NOT NULL, to_ts text, created_at text NOT NULL)",
	);
	if (options.partition)
		logs
			.prepare(
				"INSERT INTO log_partition (id, state, from_ts, to_ts, created_at) VALUES ('logs-1', ?, ?, ?, ?)",
			)
			.run(
				options.partition.state ?? "active",
				options.partition.fromTs,
				options.partition.toTs ?? null,
				NOW,
			);
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
		"INSERT INTO kernel_runtime_events (id, organization_id, kind, conversation_id, run_id, sequence, payload, created_at) VALUES (?, ?, 'message', ?, ?, ?, ?, ?)";
	main
		.prepare(event)
		.run("ev-1", ORG, "conv-a", "run-a", 1, '{"text":"hello"}', NOW);
	main
		.prepare(event)
		.run("ev-2", ORG, "conv-a", "run-a", 2, '{"text":"moved"}', NOW);
	logs
		.prepare(
			"INSERT INTO kernel_conversations (id, organization_id, conversation_id, workspace_id, last_message_at) VALUES (?, ?, ?, ?, ?)",
		)
		.run("kc-a", ORG, "conv-a", WS_A, NOW);
	logs
		.prepare(event)
		.run("ev-2", ORG, "conv-a", "run-a", 2, '{"text":"moved"}', NOW);
	logs
		.prepare(event)
		.run("ev-3", ORG, "conv-a", "run-a", 3, '{"text":"only in logs"}', NOW);
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
	return Snapshot.fromDatabases(main, [logs], options.takenAt);
}

const assignments: WorkspaceAssignments = {
	[ORG]: { unassignedOutputsHome: WS_B },
};

/** The gateway's three migration routes, answered by local objects. */
function fakeGateway(objects: WorkspaceStoreFactory) {
	const tables = new Set<string>();
	const fetchImplementation = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		const [, admin, , , org, ws, operation] = new URL(String(input)).pathname
			.split("/")
			.map(decodeURIComponent);
		if (admin !== "admin")
			return new Response("not the admin door", { status: 404 });
		const store = await objects.open({
			organizationId: org!,
			workspaceId: ws!,
		});
		try {
			const body = init?.body ? JSON.parse(String(init.body)) : undefined;
			if (!operation) return Response.json(await store.describe());
			if (operation === "import") {
				tables.add(body.table);
				return Response.json(
					await store.importRows({
						batchId: body.batchId,
						table: body.table,
						rows: (body.rows as WireRow[]).map(fromWire),
					}),
				);
			}
			const page = await store.readRows(body.table, body.after, body.limit);
			return Response.json({ rows: page.rows.map(toWire), next: page.next });
		} finally {
			await store.close();
		}
	}) as typeof fetch;
	return { fetch: fetchImplementation, tables };
}

describe("migrate-workspaces", () => {
	test("deleted workspace outputs need an approved home and retain every revision; orphan chat stays", async () => {
		const snapshot = fixtureSnapshot();
		const workDir = mkdtempSync(join(tmpdir(), "mw-orphan-"));
		try {
			snapshot.main.exec(
				"UPDATE os_outputs SET workspace_id = 'deleted-workspace' WHERE id = 'out-b1'",
			);
			snapshot.main.exec(
				"UPDATE kernel_conversations SET workspace_id = 'deleted-workspace' WHERE id = 'kc-a'",
			);
			expect(checkAssignments(snapshot, {})).toHaveLength(1);
			const report = await rehearse(snapshot, assignments, { workDir });
			expect(report.ok).toBe(true);
			const home = await new LocalBundleStore(join(workDir, "bundles")).read({
				organizationId: ORG,
				workspaceId: WS_B,
			});
			expect(
				home.tables.get("os_outputs")!.map((r) => [r.id, r.workspace_id]),
			).toEqual([["out-b1", WS_B]]);
			expect(home.tables.get("os_output_revisions")!.map((r) => r.id)).toEqual([
				"rev-b1-1",
			]);
			expect(
				report.reconcile.knownDifferences.some((d) =>
					d.includes("conversation kc-a"),
				),
			).toBe(true);
			expect(
				report.reconcile.totals.find(
					(t) => t.table === "kernel_runtime_events",
				),
			).toEqual({
				table: "kernel_runtime_events",
				source: 0,
				bundled: 0,
				staying: 4,
			});
			expect(
				snapshot.main
					.prepare("SELECT workspace_id FROM os_outputs WHERE id = 'out-b1'")
					.get()?.workspace_id,
			).toBe("deleted-workspace");
			expect(
				snapshot.main
					.prepare(
						"SELECT count(*) AS n FROM kernel_runtime_runs WHERE id = 'run-a'",
					)
					.get()?.n,
			).toBe(1);
		} finally {
			rmSync(workDir, { recursive: true, force: true });
			snapshot.close();
		}
	});

	test("retention decisions explain exact reviewed gaps; new gaps and changed run timestamps still block import", async () => {
		const snapshot = fixtureSnapshot();
		const workDir = mkdtempSync(join(tmpdir(), "mw-retention-"));
		try {
			snapshot.main.exec(
				"DELETE FROM kernel_runtime_events; UPDATE kernel_runtime_runs SET latest_event_at = '2026-01-01T00:00:00Z' WHERE id = 'run-a'",
			);
			snapshot.logs[0]!.exec("DELETE FROM kernel_runtime_events");
			const bundles = new LocalBundleStore(join(workDir, "bundles"));
			await exportAll(snapshot, bundles, assignments);
			expect(
				(await proveSnapshot(bundles, snapshot)).some((p) =>
					p.includes("run run-a recorded events"),
				),
			).toBe(true);
			const reviewed: WorkspaceAssignments = {
				[ORG]: {
					...assignments[ORG]!,
					retainedHistory: [
						{
							runId: "run-a",
							latestEventAt: "2026-01-01T00:00:00Z",
							reason: "Events expired before log retention began",
							evidenceRef: "https://example.org/work/retention-decision",
						},
					],
				},
			};
			const report = await rehearse(snapshot, reviewed, { workDir });
			expect(report.ok).toBe(true);
			expect(report.reconcile.knownDifferences).toHaveLength(1);
			expect(report.reconcile.knownDifferences[0]).toContain(
				"retention-decision",
			);
			snapshot.main.exec(
				"UPDATE kernel_runtime_runs SET latest_event_at = '2026-01-02T00:00:00Z' WHERE id = 'run-a'",
			);
			await exportAll(snapshot, bundles, reviewed);
			expect(
				(await proveSnapshot(bundles, snapshot)).some((p) =>
					p.includes("run run-a recorded events"),
				),
			).toBe(true);
			snapshot.main.exec(
				"INSERT INTO kernel_runtime_runs (id, organization_id, conversation_id, status, latest_event_at) VALUES ('run-new', 'org-fixture', 'conv-a', 'completed', '2026-01-01T00:00:00Z')",
			);
			await exportAll(snapshot, bundles, reviewed);
			expect(
				(await proveSnapshot(bundles, snapshot)).some((p) =>
					p.includes("run run-new recorded events"),
				),
			).toBe(true);
		} finally {
			rmSync(workDir, { recursive: true, force: true });
			snapshot.close();
		}
	});

	test("rejects conflicting event copies across the main and log snapshots", () => {
		const snapshot = fixtureSnapshot();
		try {
			const events = WORKSPACE_TABLES.find(
				(mapping) => mapping.table === "kernel_runtime_events",
			)!;
			const ref = { organizationId: ORG, workspaceId: WS_A };
			for (const db of [snapshot.main, ...snapshot.logs])
				expect(
					db
						.prepare(
							"SELECT created_at FROM kernel_runtime_events WHERE id = ?",
						)
						.get("ev-2")?.created_at,
				).toBe(NOW);
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

	test("a remote import needs the snapshot and refuses a stale, incomplete or changed one before contacting a target", async () => {
		const workDir = mkdtempSync(join(tmpdir(), "mw-remote-refusals-"));
		const exported = fixtureSnapshot();
		try {
			const bundles = new LocalBundleStore(join(workDir, "bundles"));
			await exportAll(exported, bundles, assignments);
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
				await expect(importAll(bundles, stores)).rejects.toThrow(
					"Remote import refused: pass the snapshot",
				);
				const stale = fixtureSnapshot({
					takenAt: new Date(Date.now() - SNAPSHOT_MAX_AGE_MS - 60_000),
				});
				await expect(
					importAll(bundles, stores, { snapshot: stale }),
				).rejects.toThrow(/take a new one/);
				stale.close();
				const changed = fixtureSnapshot({ takenAt: exported.takenAt });
				changed.logs[0]!.prepare(
					"INSERT INTO kernel_runtime_events (id, organization_id, kind, conversation_id, run_id, sequence, payload, created_at) VALUES ('ev-late', ?, 'message', 'conv-a', 'run-a', 4, '{}', ?)",
				).run(ORG, NOW);
				await expect(
					importAll(bundles, stores, { snapshot: changed }),
				).rejects.toThrow("log 1 kernel_runtime_events: count 2 -> 3");
				changed.close();
				const withoutLogs = Snapshot.fromDatabases(
					fixtureSnapshot().main,
					[],
					exported.takenAt,
				);
				await expect(
					importAll(bundles, stores, { snapshot: withoutLogs }),
				).rejects.toThrow("snapshot has no log partition");
				withoutLogs.close();
			}
			expect(requests).toBe(0);
		} finally {
			exported.close();
			rmSync(workDir, { recursive: true, force: true });
		}
	});

	test("historical log coverage: partitions must reach the oldest run, and a run's recorded events must be somewhere", async () => {
		const workDir = mkdtempSync(join(tmpdir(), "mw-log-coverage-"));
		const snapshot = fixtureSnapshot({
			partition: { fromTs: "2026-11-01T00:00:00.000Z" },
		});
		try {
			snapshot.main.exec(
				"UPDATE kernel_runtime_runs SET created_at = '2026-10-01T00:00:00.000Z' WHERE id = 'run-a'",
			);
			snapshot.main.exec(
				"INSERT INTO kernel_runtime_runs (id, organization_id, conversation_id, status, latest_event_at) VALUES ('run-lost', 'org-fixture', 'conv-a', 'completed', '2026-10-02T00:00:00.000Z')",
			);
			const bundles = new LocalBundleStore(join(workDir, "bundles"));
			await exportAll(snapshot, bundles, assignments);
			const problems = await proveSnapshot(bundles, snapshot);
			expect(problems).toContain(
				"log partitions start at 2026-11-01T00:00:00.000Z, after the oldest run (2026-10-01T00:00:00.000Z); a partition is missing",
			);
			expect(problems).toContain(
				`${ORG}/${WS_A}: run run-lost recorded events (latest 2026-10-02T00:00:00.000Z) but none is in the snapshot; a log partition is missing`,
			);
			// reconcile --snapshot fails on the same findings.
			const stores = localStoreFactory(join(workDir, "objects"));
			expect(
				(await reconcileAll(bundles, stores, { snapshot })).problems,
			).toEqual(expect.arrayContaining(problems.slice(0, 1)));
		} finally {
			snapshot.close();
			rmSync(workDir, { recursive: true, force: true });
		}
	});

	test("a full snapshot names every log partition once: one active, ranges in order", async () => {
		const { validateSnapshot } = await import("./snapshot-proof");
		const partition = (
			id: string,
			state: string,
			fromTs: string,
			toTs: string | null,
		) => {
			const db = sharedDatabase();
			db.exec(
				"CREATE TABLE IF NOT EXISTS log_partition (id text PRIMARY KEY NOT NULL, state text NOT NULL, from_ts text NOT NULL, to_ts text, created_at text NOT NULL)",
			);
			db.prepare(
				"INSERT INTO log_partition (id, state, from_ts, to_ts, created_at) VALUES (?, ?, ?, ?, ?)",
			).run(id, state, fromTs, toTs, NOW);
			return db;
		};
		const main = sharedDatabase();
		const sealed = partition("logs-1", "sealed", "2026-01-01", "2026-06-30");
		const active = partition("logs-2", "active", "2026-07-01", null);
		expect(
			validateSnapshot(Snapshot.fromDatabases(main, [sealed, active])),
		).toEqual([]);
		expect(validateSnapshot(Snapshot.fromDatabases(main, [sealed]))).toEqual([
			"the newest log partition must be the only active one; the active partition is missing",
		]);
		const overlapping = partition("logs-3", "active", "2026-06-01", null);
		expect(
			validateSnapshot(Snapshot.fromDatabases(main, [sealed, overlapping])),
		).toEqual(["log partitions logs-1 and logs-3 overlap"]);
		const unranged = sharedDatabase();
		unranged.exec(
			"CREATE TABLE IF NOT EXISTS log_partition (id text PRIMARY KEY NOT NULL, state text NOT NULL, from_ts text NOT NULL, to_ts text, created_at text NOT NULL)",
		);
		expect(
			validateSnapshot(Snapshot.fromDatabases(main, [unranged, active])),
		).toEqual([
			"a log partition without a range holds all dates, so it must be the only one",
		]);
		expect(
			validateSnapshot(Snapshot.fromDatabases(main, [sharedDatabase()])),
		).toEqual([
			"log snapshot 1 has no log_partition table; it is not a log partition",
		]);
	});

	test("a remote import with a proven snapshot loads one scoped workspace, and reconcile --snapshot shows zero differences", async () => {
		const workDir = mkdtempSync(join(tmpdir(), "mw-remote-"));
		const snapshot = fixtureSnapshot();
		try {
			const scope = Scope.parse(`${ORG}/${WS_A}`);
			const bundles = new LocalBundleStore(join(workDir, "bundles"));
			const exported = await exportAll(snapshot, bundles, assignments, {
				scope,
			});
			expect(exported.map((r) => r.workspaceId)).toEqual([WS_A]);
			const fallbackDdl = (table: string) =>
				String(
					snapshot.main
						.prepare("SELECT sql FROM sqlite_master WHERE name = ?")
						.get(table)?.sql ?? "",
				) || null;
			const gateway = fakeGateway(
				localStoreFactory(join(workDir, "objects"), { fallbackDdl }),
			);
			const stores = remoteStoreFactory(
				"https://tedix.mcp.example",
				{ mode: "tedix", headers: async () => ({}) },
				gateway.fetch,
			);
			const imported = await importAll(bundles, stores, { snapshot, scope });
			expect(imported.map((r) => [r.workspaceId, r.imported])).toEqual([
				[WS_A, 12],
			]);
			const report = await reconcileAll(bundles, stores, { snapshot, scope });
			expect(report.problems).toEqual([]);
			expect(report.ok).toBe(true);
			expect(
				Object.fromEntries(
					report.totals.map((t) => [t.table, [t.source, t.bundled]]),
				).kernel_runtime_events,
			).toEqual([3, 3]);
			// Organization memory is never sent to a workspace object.
			expect(gateway.tables.has("memory_facts")).toBe(false);
			await expect(
				importAll(bundles, stores, {
					snapshot,
					scope: Scope.parse(`${ORG}/${WS_B}`),
				}),
			).rejects.toThrow(`scope names ${ORG}/${WS_B}, which has no bundle`);
		} finally {
			snapshot.close();
			rmSync(workDir, { recursive: true, force: true });
		}
	});

	test.each([
		"title",
		"organization_id",
		"missing-summary",
		"missing-rows",
		"unmapped",
	])("rejects bundle damage before opening a target: %s", async (damage) => {
		const snapshot = fixtureSnapshot();
		const workDir = mkdtempSync(join(tmpdir(), "mw-preflight-"));
		try {
			const bundles = new LocalBundleStore(join(workDir, "bundles"));
			await exportAll(snapshot, bundles, assignments);
			const ref = { organizationId: ORG, workspaceId: WS_A };
			const { manifest, tables } = await bundles.read(ref);
			if (damage === "missing-summary") delete manifest.tables.os_outputs;
			else if (damage === "missing-rows") tables.delete("os_outputs");
			else if (damage === "unmapped") tables.set("memory_facts", []);
			else tables.get("os_outputs")![0]![damage] = "changed";
			let opens = 0;
			await expect(
				importAll(
					{
						write: bundles.write.bind(bundles),
						list: async () => [ref],
						read: async () => ({ manifest, tables }),
					},
					{
						kind: "local",
						open: async () => {
							opens += 1;
							throw new Error("target opened");
						},
					},
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
			// outputs 1 + revisions 2 + resource 1 + conversation 1 + run 1 + events 3 (one only in the log partition, one in both) + tool result 1 + artifact 1 + the workspace's own directory row; organization memory stays behind
			expect(a.rows).toBe(12);
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
			// Output tables come from the object's migration chain.
			expect(report.fallbackTables).not.toContain("os_outputs");
			expect(WORKSPACE_TABLES.some((m) => m.table.startsWith("memory_"))).toBe(
				false,
			);
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
			expect(first.map((r) => r.imported)).toEqual([12, 3]);
			expect(second.map((r) => [r.imported, r.duplicates])).toEqual([
				[0, 12],
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

	test("a fresh snapshot adds rows to an earlier import without reusing its receipts", async () => {
		const snapshot = fixtureSnapshot();
		const workDir = mkdtempSync(join(tmpdir(), "mw-test-"));
		try {
			const bundles = new LocalBundleStore(join(workDir, "bundles"));
			const stores = localStoreFactory(join(workDir, "objects"));
			await exportAll(snapshot, bundles, assignments);
			await importAll(bundles, stores);
			snapshot.main.exec(
				"INSERT INTO kernel_runtime_events (id, organization_id, kind, conversation_id, run_id, payload, created_at) SELECT 'ev-new', organization_id, kind, conversation_id, run_id, payload, created_at FROM kernel_runtime_events WHERE id = 'ev-1'",
			);
			await exportAll(snapshot, bundles, assignments);
			const results = await importAll(bundles, stores, { snapshot });
			expect(results.map((r) => [r.imported, r.duplicates])).toEqual([
				[1, 12],
				[0, 3],
			]);
			expect((await reconcileAll(bundles, stores, { snapshot })).ok).toBe(true);
		} finally {
			rmSync(workDir, { recursive: true, force: true });
			snapshot.close();
		}
	});

	test("an existing row conflict stops before any table is imported", async () => {
		const snapshot = fixtureSnapshot();
		const workDir = mkdtempSync(join(tmpdir(), "mw-test-"));
		try {
			const bundles = new LocalBundleStore(join(workDir, "bundles"));
			const stores = localStoreFactory(join(workDir, "objects"));
			await exportAll(snapshot, bundles, assignments);
			await importAll(bundles, stores);
			snapshot.main.exec(
				"UPDATE kernel_runtime_events SET payload = 'changed' WHERE id = 'ev-1'",
			);
			await exportAll(snapshot, bundles, assignments);
			let writes = 0;
			const guarded: WorkspaceStoreFactory = {
				kind: "local",
				async open(ref) {
					const store = await stores.open(ref);
					return {
						describe: () => store.describe(),
						readRows: (...args) => store.readRows(...args),
						close: () => store.close(),
						async importRows(batch) {
							writes += 1;
							return store.importRows(batch);
						},
					};
				},
			};
			await expect(importAll(bundles, guarded, { snapshot })).rejects.toThrow(
				"existing kernel_runtime_events row differs",
			);
			expect(writes).toBe(0);
		} finally {
			rmSync(workDir, { recursive: true, force: true });
			snapshot.close();
		}
	});

	test("outputs without a workspace need a home, then move with their revisions", async () => {
		const snapshot = fixtureSnapshot({ unassignedOutput: true });
		const workDir = mkdtempSync(join(tmpdir(), "mw-test-"));
		try {
			expect(checkAssignments(snapshot, {})).toEqual([
				`organization ${ORG}: 1 outputs have no workspace and no unassignedOutputsHome`,
			]);
			expect(
				checkAssignments(snapshot, {
					[ORG]: { unassignedOutputsHome: "nope" },
				}),
			).toEqual([
				`organization ${ORG}: unassignedOutputsHome nope is not a workspace of that organization`,
			]);
			// A scope that leaves the organization out does not need its choice.
			expect(
				checkAssignments(snapshot, {}, Scope.parse("org-other/ws-x")),
			).toEqual([]);
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
			stripped.exec("ALTER TABLE tedi_artifacts DROP COLUMN name");
			const findings = checkSchema(Snapshot.fromDatabases(stripped)).findings;
			expect(
				findings.find((f) => f.table === "tedi_artifacts")?.detail,
			).toContain("only in object: [name]");
		} finally {
			object.close();
			snapshot.close();
		}
	});

	test("assignments proposes the oldest workspace as home, a new Home for a live organization without one, and reports deleted organizations", async () => {
		const snapshot = fixtureSnapshot({ unassignedOutput: true });
		snapshot.main.exec(
			"INSERT INTO organizations (id, name, slug) VALUES ('org-live-no-ws', 'Live', 'live')",
		);
		snapshot.main.exec(
			"INSERT INTO os_outputs (id, organization_id, workspace_id, kind, title, created_by_kind, created_by_id) VALUES ('out-live', 'org-live-no-ws', NULL, 'document', 'Loose', 'user', 'u1')",
		);
		snapshot.main.exec(
			"INSERT INTO memory_facts (id, organization_id, content, fact_type) VALUES ('fact-stays', 'org-fixture', 'kept in the organization', 'preference')",
		);
		const workDir = mkdtempSync(join(tmpdir(), "mw-test-"));
		try {
			const proposal = proposeAssignments(snapshot);
			expect(proposal).toEqual({
				assignments: {
					[ORG]: { unassignedOutputsHome: WS_A },
					"org-live-no-ws": {
						unassignedOutputsHome: "home-org-live-no-ws",
						createHome: true,
					},
				},
				withoutWorkspace: ["org-live-no-ws"],
				orphaned: [],
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
			expect(totals.memory_facts).toBeUndefined();
			const home = await new LocalBundleStore(join(workDir, "bundles")).read({
				organizationId: "org-live-no-ws",
				workspaceId: "home-org-live-no-ws",
			});
			expect(
				home.tables.get("os_workspaces")!.map((r) => [r.id, r.name]),
			).toEqual([["home-org-live-no-ws", "Home"]]);
			expect(home.tables.get("os_outputs")!.map((r) => r.id)).toEqual([
				"out-live",
			]);
			expect([...home.tables.keys()].some((t) => t.startsWith("memory_"))).toBe(
				false,
			);
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

	test("a new local object matches the replayed chain, and an older object gets the migrations it lacks", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mw-test-"));
		const chain = readTenantStoreMigrations();
		const ref = { organizationId: ORG, workspaceId: WS_A };
		const direct = new DatabaseSync(":memory:");
		const older = new LocalWorkspaceStore(join(dir, "older.sqlite"), ref, {
			migrations: chain.slice(0, -1),
		});
		await older.close();
		const fresh = new LocalWorkspaceStore(join(dir, "fresh.sqlite"), ref);
		const upgraded = new LocalWorkspaceStore(join(dir, "older.sqlite"), ref);
		try {
			direct.exec("PRAGMA foreign_keys = OFF");
			for (const { sql } of chain)
				for (const statement of splitSqlStatements(sql)) direct.exec(statement);
			const schema = (db: DatabaseSync) =>
				db
					.prepare(
						"SELECT type, name, sql FROM sqlite_master WHERE name NOT IN ('__drizzle_migrations', 'tenant_store_identity') ORDER BY type, name",
					)
					.all();
			const ledger = (db: DatabaseSync) =>
				db
					.prepare("SELECT hash FROM __drizzle_migrations ORDER BY id")
					.all()
					.map((row) => row.hash);
			expect(schema(fresh.db)).toEqual(schema(direct));
			expect(schema(upgraded.db)).toEqual(schema(direct));
			expect(ledger(fresh.db)).toEqual(chain.map((m) => m.name));
			expect(ledger(upgraded.db)).toEqual(chain.map((m) => m.name));
			expect((await fresh.describe()).workspaceId).toBe(WS_A);
		} finally {
			direct.close();
			await fresh.close();
			await upgraded.close();
			rmSync(dir, { recursive: true, force: true });
		}
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

	test("only scoped indexed object-native rows are accounted for, and source conflicts still fail", async () => {
		const snapshot = fixtureSnapshot();
		const workDir = mkdtempSync(join(tmpdir(), "mw-native-"));
		try {
			const bundles = new LocalBundleStore(join(workDir, "bundles"));
			const stores = localStoreFactory(join(workDir, "objects"));
			await exportAll(snapshot, bundles, assignments);
			await importAll(bundles, stores);
			const ref = { organizationId: ORG, workspaceId: WS_A };
			const local = (await stores.open(ref)) as LocalWorkspaceStore;
			local.db.exec(
				`INSERT INTO os_outputs (id,organization_id,workspace_id,kind,title,current_revision_id,created_by_kind,created_by_id) VALUES ('native','${ORG}','${WS_A}','document','Native','native-rev','user','u1')`,
			);
			local.db.exec(
				`INSERT INTO os_output_revisions (id,organization_id,output_id,revision,content,created_by_kind,created_by_id) VALUES ('native-rev','${ORG}','native',1,'{}','user','u1')`,
			);
			await local.close();
			let writes = 0;
			const owned: WorkspaceStoreFactory = {
				kind: "local",
				async open(scope) {
					const store = await stores.open(scope);
					return {
						describe: async () => ({
							...(await store.describe()),
							outputAuthority: "object" as const,
						}),
						readRows: (...args) => store.readRows(...args),
						close: () => store.close(),
						importRows: async (batch) => {
							writes++;
							return store.importRows(batch);
						},
					};
				},
			};
			const scope = Scope.parse(`${ORG}/${WS_A}`);
			const evidence = {
				authorityBeforeStaging: "object" as const,
				evidenceRef: "evidence://fixture/source-read",
				sourceOutputIds: ["out-a1"],
				indexRows: [{ ...ref, outputId: "native", revisionId: "native-rev" }],
			};
			const run = (e = evidence, factory = owned) =>
				reconcileAll(bundles, factory, {
					snapshot,
					scope,
					objectNativeEvidence: async () => e,
				});
			expect((await reconcileAll(bundles, owned, { snapshot, scope })).ok).toBe(
				false,
			);
			const report = await run();
			expect(report.ok).toBe(true);
			expect(
				report.workspaces[0]!.objectNativeRows.map((r) => r.table),
			).toEqual(["os_outputs", "os_output_revisions"]);
			expect((await run({ ...evidence, indexRows: [] })).ok).toBe(false);
			await expect(
				run({ ...evidence, sourceOutputIds: ["native"] }),
			).rejects.toThrow("present in source");
			await expect(
				run({
					...evidence,
					indexRows: [{ ...evidence.indexRows[0]!, workspaceId: WS_B }],
				}),
			).rejects.toThrow("wrong scope");
			await expect(run(evidence, stores)).rejects.toThrow("object authority");
			await importAll(bundles, owned, { snapshot, scope });
			expect(writes).toBe(0);
			const changed = (await stores.open(ref)) as LocalWorkspaceStore;
			changed.db.exec(
				"UPDATE os_outputs SET title='Changed' WHERE id='out-a1'",
			);
			await changed.close();
			expect((await run()).ok).toBe(false);
			await expect(
				importAll(bundles, owned, { snapshot, scope }),
			).rejects.toThrow("existing os_outputs row differs");
			expect(writes).toBe(0);
			const restored = (await stores.open(ref)) as LocalWorkspaceStore;
			restored.db.exec("UPDATE os_outputs SET title='Plan' WHERE id='out-a1'");
			restored.db.exec(
				`INSERT INTO os_output_revisions (id,organization_id,output_id,revision,content,created_by_kind,created_by_id) VALUES ('unindexed-rev','${ORG}','native',2,'{}','user','u1')`,
			);
			await restored.close();
			expect((await run()).ok).toBe(false);
			// A D1-only output cannot be added to an object-owned workspace.
			snapshot.main.exec(
				`INSERT INTO os_outputs (id,organization_id,workspace_id,kind,title,created_by_kind,created_by_id) VALUES ('new-source','${ORG}','${WS_A}','document','Source','user','u1')`,
			);
			await exportAll(snapshot, bundles, assignments);
			await expect(
				importAll(bundles, owned, { snapshot, scope }),
			).rejects.toThrow("cannot add os_outputs");
			expect(writes).toBe(0);
		} finally {
			rmSync(workDir, { recursive: true, force: true });
			snapshot.close();
		}
	});

	test("an approved merge adds source-only rows to a named object-owned workspace and never changes an object row", async () => {
		const snapshot = fixtureSnapshot();
		const workDir = mkdtempSync(join(tmpdir(), "mw-merge-"));
		try {
			const bundles = new LocalBundleStore(join(workDir, "bundles"));
			const stores = localStoreFactory(join(workDir, "objects"));
			await exportAll(snapshot, bundles, assignments);
			await importAll(bundles, stores);
			const ref = { organizationId: ORG, workspaceId: WS_A };
			const revision = (id: string, output: string, n: number) =>
				`INSERT INTO os_output_revisions (id,organization_id,output_id,revision,content,created_by_kind,created_by_id) VALUES ('${id}','${ORG}','${output}',${n},'{}','user','u1')`;
			const output = (id: string, status: string, current: string) =>
				`INSERT INTO os_outputs (id,organization_id,workspace_id,kind,title,status,current_revision_id,created_by_kind,created_by_id) VALUES ('${id}','${ORG}','${WS_A}','document','${id}','${status}','${current}','user','u1')`;
			// The object moved on: a new current revision, a new title, its own output.
			const local = (await stores.open(ref)) as LocalWorkspaceStore;
			local.db.exec(revision("rev-a1-3", "out-a1", 3));
			local.db.exec(
				"UPDATE os_outputs SET title='Object title', current_revision_id='rev-a1-3' WHERE id='out-a1'",
			);
			local.db.exec(output("native", "active", "native-rev"));
			local.db.exec(revision("native-rev", "native", 1));
			await local.close();
			// The source diverged: a later revision, a new output, an archived one.
			snapshot.main.exec(revision("rev-a1-4", "out-a1", 4));
			snapshot.main.exec(
				"UPDATE os_outputs SET current_revision_id='rev-a1-4' WHERE id='out-a1'",
			);
			snapshot.main.exec(output("src-new", "active", "src-new-1"));
			snapshot.main.exec(revision("src-new-1", "src-new", 1));
			snapshot.main.exec(output("src-arch", "archived", "src-arch-1"));
			snapshot.main.exec(revision("src-arch-1", "src-arch", 1));
			await exportAll(snapshot, bundles, assignments);
			let writes = 0;
			const owned: WorkspaceStoreFactory = {
				kind: "local",
				async open(scope) {
					const store = await stores.open(scope);
					return {
						describe: async () => ({
							...(await store.describe()),
							outputAuthority: "object" as const,
						}),
						readRows: (...args) => store.readRows(...args),
						close: () => store.close(),
						importRows: async (batch) => {
							writes++;
							return store.importRows(batch);
						},
					};
				},
			};
			const scope = Scope.parse(`${ORG}/${WS_A}`);
			const both = Scope.parse(`${ORG}/${WS_A},${ORG}/${WS_B}`);
			const other = Scope.parse(`${ORG}/${WS_B}`);
			// Without the mode, and for a workspace the mode does not name, the refusals stand.
			await expect(
				importAll(bundles, owned, { snapshot, scope }),
			).rejects.toThrow("existing os_outputs row differs");
			await expect(
				importAll(bundles, owned, {
					snapshot,
					scope: both,
					mergeObjectOwned: other,
				}),
			).rejects.toThrow("existing os_outputs row differs");
			await expect(
				importAll(bundles, owned, {
					snapshot,
					scope: other,
					mergeObjectOwned: scope,
				}),
			).rejects.toThrow("must also be named in the scope");
			await expect(
				importAll(bundles, stores, {
					snapshot,
					scope,
					mergeObjectOwned: scope,
				}),
			).rejects.toThrow("is not object-owned");
			expect(writes).toBe(0);
			const [plan] = await importAll(bundles, owned, {
				snapshot,
				scope,
				mergeObjectOwned: scope,
				mergePlanOnly: true,
			});
			expect(writes).toBe(0);
			expect(plan!.merge!.toAdd.map((r) => r.key)).toEqual([
				's"src-new"',
				's"src-new-1"',
			]);
			const [result] = await importAll(bundles, owned, {
				snapshot,
				scope,
				mergeObjectOwned: scope,
			});
			expect(result!.imported).toBe(2);
			expect(result!.merge!.objectWins).toEqual([
				{ table: "os_outputs", key: 's"out-a1"' },
			]);
			expect(result!.merge!.notAdded.map((r) => r.key).sort()).toEqual([
				's"rev-a1-4"',
				's"src-arch"',
				's"src-arch-1"',
			]);
			const after = (await stores.open(ref)) as LocalWorkspaceStore;
			const ids = (table: string) =>
				after.db
					.prepare(`SELECT id FROM ${table} ORDER BY id`)
					.all()
					.map((row) => String(row.id));
			expect(ids("os_outputs")).toEqual(["native", "out-a1", "src-new"]);
			expect(ids("os_output_revisions")).toEqual([
				"native-rev",
				"rev-a1-1",
				"rev-a1-2",
				"rev-a1-3",
				"src-new-1",
			]);
			expect(
				after.db
					.prepare(
						"SELECT title, current_revision_id FROM os_outputs WHERE id='out-a1'",
					)
					.get(),
			).toMatchObject({
				title: "Object title",
				current_revision_id: "rev-a1-3",
			});
			await after.close();
			// A rerun adds nothing.
			const [again] = await importAll(bundles, owned, {
				snapshot,
				scope,
				mergeObjectOwned: scope,
			});
			expect(again!.imported).toBe(0);
			expect((await reconcileAll(bundles, owned, { snapshot, scope })).ok).toBe(
				false,
			);
			const approved = (ref: { workspaceId: string }) =>
				ref.workspaceId === WS_A
					? { evidenceRef: "evidence://fixture/owner", mergeObjectOwned: true }
					: undefined;
			const report = await reconcileAll(bundles, owned, {
				snapshot,
				scope,
				approvedAccounting: approved,
			});
			expect(report.ok).toBe(true);
			const workspace = report.workspaces[0]!;
			expect(workspace.merge!.objectWins).toHaveLength(1);
			expect(workspace.merge!.notAdded).toHaveLength(3);
			expect(workspace.objectNativeRows.map((r) => r.key).sort()).toEqual([
				's"native"',
				's"native-rev"',
				's"rev-a1-3"',
			]);
			// A row that differs later is listed as the object's own, never hidden.
			const changed = (await stores.open(ref)) as LocalWorkspaceStore;
			changed.db.exec("UPDATE os_outputs SET title='x' WHERE id='src-new'");
			await changed.close();
			const drifted = await reconcileAll(bundles, owned, {
				snapshot,
				scope,
				approvedAccounting: approved,
			});
			expect(drifted.ok).toBe(true);
			expect(drifted.workspaces[0]!.merge!.objectWins).toHaveLength(2);
			await expect(
				reconcileAll(bundles, stores, {
					snapshot,
					scope,
					approvedAccounting: approved,
				}),
			).rejects.toThrow("is not object-owned");
		} finally {
			rmSync(workDir, { recursive: true, force: true });
			snapshot.close();
		}
	});

	test("approved object-native outputs are accounted for by exact id on a staged workspace", async () => {
		const snapshot = fixtureSnapshot();
		const workDir = mkdtempSync(join(tmpdir(), "mw-approved-"));
		try {
			const bundles = new LocalBundleStore(join(workDir, "bundles"));
			const stores = localStoreFactory(join(workDir, "objects"));
			await exportAll(snapshot, bundles, assignments);
			const ref = { organizationId: ORG, workspaceId: WS_A };
			const local = (await stores.open(ref)) as LocalWorkspaceStore;
			local.db.exec(
				`INSERT INTO os_outputs (id,organization_id,workspace_id,kind,title,current_revision_id,created_by_kind,created_by_id) VALUES ('native','${ORG}','${WS_A}','document','Native','native-rev','user','u1'), ('stray','${ORG}','${WS_A}','document','Stray',NULL,'user','u1')`,
			);
			local.db.exec(
				`INSERT INTO os_output_revisions (id,organization_id,output_id,revision,content,created_by_kind,created_by_id) VALUES ('native-rev','${ORG}','native',1,'{}','user','u1')`,
			);
			await local.close();
			const scope = Scope.parse(`${ORG}/${WS_A}`);
			await importAll(bundles, stores, { snapshot, scope });
			const run = (ids: string[]) =>
				reconcileAll(bundles, stores, {
					snapshot,
					scope,
					approvedAccounting: () => ({
						evidenceRef: "evidence://fixture/owner",
						objectNativeOutputIds: ids,
					}),
				});
			expect(
				(await reconcileAll(bundles, stores, { snapshot, scope })).ok,
			).toBe(false);
			// Only the listed ids are accounted for.
			expect((await run(["native"])).ok).toBe(false);
			const report = await run(["native", "stray"]);
			expect(report.ok).toBe(true);
			expect(report.workspaces[0]!.objectNativeRows.map((r) => r.key)).toEqual([
				's"native"',
				's"stray"',
				's"native-rev"',
			]);
			expect((await run(["native", "stray", "gone"])).ok).toBe(false);
			await expect(run(["native", "stray", "out-a1"])).rejects.toThrow(
				"present in source",
			);
		} finally {
			rmSync(workDir, { recursive: true, force: true });
			snapshot.close();
		}
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

for (const changesDuringRead of [false, true])
	test(`reconciliation ${changesDuringRead ? "refuses a changing" : "retains a stable"} import generation`, async () => {
		const workDir = mkdtempSync(join(tmpdir(), "generation-proof-"));
		const snapshot = fixtureSnapshot();
		const bundles = new LocalBundleStore(join(workDir, "bundles"));
		const stores = localStoreFactory(join(workDir, "objects"));
		try {
			await exportAll(snapshot, bundles, {});
			await importAll(bundles, stores);
			const withGeneration: WorkspaceStoreFactory = {
				kind: "remote",
				async open(ref) {
					const store = await stores.open(ref);
					let descriptions = 0;
					return {
						describe: async () => ({
							...(await store.describe()),
							importGeneration: changesDuringRead && descriptions++ > 0 ? 4 : 3,
						}),
						importRows: (batch) => store.importRows(batch),
						readRows: (table, after, limit) =>
							store.readRows(table, after, limit),
						close: () => store.close(),
					};
				},
			};
			const report = await reconcileAll(bundles, withGeneration, { snapshot });
			expect(report.ok).toBe(!changesDuringRead);
			for (const workspace of report.workspaces) {
				expect(workspace.importGeneration).toBe(3);
				expect(workspace.problems).toEqual(
					changesDuringRead ? ["Import changed during reconciliation"] : [],
				);
			}
		} finally {
			snapshot.close();
			rmSync(workDir, { recursive: true, force: true });
		}
	});

test("CLI frozen reconciliation proves the snapshot and refuses a capture preceding the freeze", async () => {
	const dir = mkdtempSync(join(tmpdir(), "frozen-reconcile-"));
	const source = fixtureSnapshot();
	const mainPath = join(dir, "main.sqlite");
	const logPath = join(dir, "logs.sqlite");
	writeFileSync(mainPath, source.main.serialize());
	writeFileSync(logPath, source.logs[0]!.serialize());
	source.close();
	const snapshot = Snapshot.open({ main: mainPath, logs: [logPath] });
	const bundlePath = join(dir, "bundles");
	const objectPath = join(dir, "objects");
	const reportPath = join(dir, "report.json");
	try {
		const bundles = new LocalBundleStore(bundlePath);
		await exportAll(snapshot, bundles, {});
		await importAll(bundles, localStoreFactory(objectPath));
		const args = [
			"reconcile",
			"--snapshot",
			mainPath,
			"--logs",
			logPath,
			"--bundles",
			bundlePath,
			"--objects",
			objectPath,
			"--freeze-ref",
			"fixture:freeze",
			"--report",
			reportPath,
		];
		const frozenAt = new Date(snapshot.takenAt.getTime() - 1000).toISOString();
		expect(await main([...args, "--frozen-at", frozenAt], {}, () => {})).toBe(
			0,
		);
		const report = JSON.parse(
			readFileSync(reportPath, "utf8"),
		) as import("./reconcile").ReconcileReport;
		expect(report.freeze).toEqual({ frozenAt, evidenceRef: "fixture:freeze" });
		expect(report.totals).toHaveLength(WORKSPACE_TABLES.length);
		await expect(
			main([...args, "--frozen-at", new Date().toISOString()], {}, () => {}),
		).rejects.toThrow("snapshot begun after the freeze");
	} finally {
		snapshot.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("frozen delta repairs changed/deleted rows, preserves untracked rows and resumes after a lost receipt", async () => {
	const dir = mkdtempSync(join(tmpdir(), "frozen-delta-"));
	const snapshot = fixtureSnapshot({ takenAt: new Date() });
	const baseline = new LocalBundleStore(join(dir, "baseline"));
	const final = new LocalBundleStore(join(dir, "final"));
	try {
		await exportAll(snapshot, baseline, {});
		const copies = new Map<string, Map<string, import("./rows").StoredRow[]>>();
		for (const ref of await baseline.list())
			copies.set(ref.workspaceId, (await baseline.read(ref)).tables);
		copies
			.get(WS_A)!
			.get("os_outputs")!
			.push({ id: "native-only", title: "Keep native" });
		snapshot.main.exec(
			"UPDATE os_outputs SET title='Final title' WHERE id='out-a1'",
		);
		snapshot.main.exec("DELETE FROM os_workspace_resources WHERE id='res-a'");
		await exportAll(snapshot, final, {});
		let generation = 7,
			writes = 0,
			loseReceipt = true;
		const stores: WorkspaceStoreFactory = {
			kind: "remote",
			async open(ref) {
				const tables = copies.get(ref.workspaceId)!;
				return {
					async describe() {
						return {
							...ref,
							createdAt: "fixture",
							migrations: [],
							jurisdiction: "eu",
							outputAuthority: "shared",
							importGeneration: generation,
						};
					},
					async readRows(table) {
						return { rows: tables.get(table)!, next: null };
					},
					async importRows() {
						throw new Error("Not an additive import");
					},
					async applyDelta(batch) {
						expect(batch.importGeneration).toBe(generation);
						const rows = tables.get(batch.table)!;
						for (const change of batch.changes) {
							const id = (change.before ?? change.after)!.id;
							const index = rows.findIndex((r) => r.id === id);
							if (index >= 0) rows.splice(index, 1);
							if (change.after) rows.push(change.after);
						}
						writes++;
						generation++;
						if (loseReceipt) {
							loseReceipt = false;
							throw new Error("Lost HTTP response");
						}
						return {
							batchId: batch.batchId,
							table: batch.table,
							rowCount: batch.changes.length,
							status: "imported",
							importGeneration: generation,
						};
					},
					async close() {},
				};
			},
		};
		const options = {
			snapshot,
			freezeRef: "fixture:freeze",
			frozenAt: new Date(snapshot.takenAt.getTime() - 1).toISOString(),
		};
		await expect(
			applyDeltaAll(baseline, final, stores, options),
		).rejects.toThrow("Lost HTTP response");
		const results = await applyDeltaAll(baseline, final, stores, options);
		expect(writes).toBe(2);
		expect(results[0]!.alreadyApplied).toBe(1);
		expect(
			copies
				.get(WS_A)!
				.get("os_outputs")!
				.find((r) => r.id === "out-a1")!.title,
		).toBe("Final title");
		expect(
			copies
				.get(WS_A)!
				.get("os_outputs")!
				.find((r) => r.id === "native-only")!.title,
		).toBe("Keep native");
		expect(copies.get(WS_A)!.get("os_workspace_resources")).toEqual([]);
		await applyDeltaAll(baseline, final, stores, options);
		expect(writes).toBe(2);
		copies
			.get(WS_A)!
			.get("os_outputs")!
			.find((r) => r.id === "out-a1")!.title = "Different writer";
		await expect(
			applyDeltaAll(baseline, final, stores, options),
		).rejects.toThrow("no longer equals its baseline");
		expect(writes).toBe(2);
	} finally {
		snapshot.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
