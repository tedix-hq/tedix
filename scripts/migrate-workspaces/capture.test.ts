import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { capture, type CaptureConfig } from "./capture";
import { Snapshot } from "./source";
import { validateSnapshot, SNAPSHOT_MAX_AGE_MS } from "./snapshot-proof";
import { WORKSPACE_TABLES } from "./tables";
import type { RemoteD1RestResult } from "../lib/remote-d1";
import { LocalBundleStore } from "./bundle";
import { exportAll } from "./export";
import { reconcileWorkspace } from "./reconcile";

const config: CaptureConfig = {
	accountId: "fixture-account",
	mainDatabaseId: "main",
	logDatabaseIds: ["logs"],
	assignments: { "org-fixture": { unassignedOutputsHome: "ws" } },
};
function fixture() {
	const main = new DatabaseSync(":memory:");
	const logs = new DatabaseSync(":memory:");
	for (const mapping of WORKSPACE_TABLES) {
		main.exec(
			`CREATE TABLE ${mapping.table} (id TEXT, organization_id TEXT, workspace_id TEXT, conversation_id TEXT, output_id TEXT, run_id TEXT, updated_at TEXT, created_at TEXT, latest_event_at TEXT, current_revision_id TEXT, revision INTEGER)`,
		);
		main
			.prepare(
				`INSERT INTO ${mapping.table} (id, organization_id, workspace_id, conversation_id, updated_at, created_at) VALUES (?, 'org-fixture', 'ws', 'c', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
			)
			.run(mapping.table === "os_workspaces" ? "ws" : mapping.table);
	}
	main.exec(
		"INSERT INTO kernel_conversations (id, organization_id, conversation_id) VALUES ('home', 'org-fixture', 'home')",
	);
	logs.exec(
		"CREATE TABLE log_partition (id TEXT, state TEXT, from_ts TEXT, to_ts TEXT)",
	);
	logs.exec(
		"INSERT INTO log_partition VALUES ('logs', 'active', '2025-01-01T00:00:00.000Z', NULL)",
	);
	logs.exec(
		"CREATE TABLE kernel_runtime_events (id TEXT, organization_id TEXT, conversation_id TEXT, created_at TEXT)",
	);
	logs.exec(
		"INSERT INTO kernel_runtime_events VALUES ('moved', 'org-fixture', 'c', '2026-01-01T00:00:00.000Z'), ('home', 'org-fixture', 'home', '2026-01-01T00:00:00.000Z'), ('other-org', 'org-other', 'c', '2026-01-01T00:00:00.000Z')",
	);
	const query = async (
		database: string,
		sql: string,
		params: (string | number | null)[],
	): Promise<RemoteD1RestResult> => {
		expect(sql.startsWith("SELECT ")).toBe(true);
		expect(sql).not.toContain(";");
		expect(sql).not.toMatch(/OFFSET/i);
		return {
			ok: true,
			status: 200,
			result: [
				{
					success: true,
					results: (database === "main" ? main : logs)
						.prepare(sql)
						.all(...params),
				},
			],
		};
	};
	return { main, logs, query };
}

test("capture paces serial keyset pages, resumes committed cursor, filters logs, hashes bytes and preserves export gates", async () => {
	const dir = mkdtempSync(join(tmpdir(), "paced-capture-"));
	const { main, logs, query } = fixture();
	const waits: number[] = [];
	let pages = 0;
	const options = {
		apiToken: "fixture",
		pageSize: 1,
		sleep: async (ms: number) => {
			waits.push(ms);
		},
		log: () => {},
	};
	try {
		await expect(
			capture(config, dir, {
				...options,
				query: async (db, sql, params) => {
					if (sql.includes("__capture_rowid") && ++pages === 4)
						throw new Error("interrupted");
					return query(db, sql, params);
				},
			}),
		).rejects.toThrow("interrupted");
		// An external cursor mirror can lag a committed SQLite page after interruption.
		writeFileSync(join(dir, "cursor.json"), "{}");
		const manifest = await capture(config, dir, { ...options, query });
		expect(waits.every((ms) => ms >= 2000)).toBe(true);
		expect(manifest.proof.main.tables.os_workspaces?.count).toBe(1);
		expect(manifest.proof.logs[0]?.tables.kernel_runtime_events?.count).toBe(1);
		expect(manifest.proof.main.tables.os_outputs?.sha256).toMatch(
			/^[0-9a-f]{64}$/,
		);
		const snapshot = Snapshot.open({ main: join(dir, "manifest.json") });
		expect(validateSnapshot(snapshot)).toEqual([]);
		expect(
			snapshot.main.prepare("SELECT count(*) AS n FROM os_workspaces").get()?.n,
		).toBe(1);
		expect(
			snapshot.logs[0]?.prepare("SELECT id FROM kernel_runtime_events").all(),
		).toEqual([{ id: "moved" }]);
		expect(
			validateSnapshot(
				snapshot,
				new Date(Date.parse(manifest.endedAt) + SNAPSHOT_MAX_AGE_MS + 1),
			).join(),
		).toContain("more than 2 hours");
		snapshot.close();
		const plain = Snapshot.fromDatabases(new DatabaseSync(":memory:"));
		expect(validateSnapshot(plain).join()).toContain("no log partition");
		plain.close();
		const damaged = new DatabaseSync(join(dir, "main.sqlite"));
		damaged.exec("DELETE FROM os_outputs");
		damaged.close();
		const reopened = Snapshot.open({ main: join(dir, "manifest.json") });
		expect(validateSnapshot(reopened).join()).toContain("os_outputs");
		reopened.close();
		await expect(
			capture({ ...config, logDatabaseIds: ["other"] }, dir, {
				...options,
				query,
			}),
		).rejects.toThrow("configuration differs");
	} finally {
		main.close();
		logs.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("overload envelopes back off at least 30 seconds and permanent failures stop", async () => {
	const dir = mkdtempSync(join(tmpdir(), "paced-overload-"));
	const { main, logs, query } = fixture();
	const waits: number[] = [];
	let calls = 0;
	try {
		const manifest = await capture(config, dir, {
			apiToken: "fixture",
			sleep: async (ms) => {
				waits.push(ms);
			},
			log: () => {},
			query: async (db, sql, params) => {
				if (++calls === 1)
					return {
						ok: true,
						status: 200,
						result: [
							{
								success: false,
								error: "7429 Database temporarily unavailable",
							},
						],
					};
				return query(db, sql, params);
			},
		});
		expect(manifest.backoffs).toBe(1);
		expect(waits).toContain(30000);
		expect(manifest.delayMs).toBe(4000);
		const path = join(dir, "manifest.json");
		const incomplete = JSON.parse(readFileSync(path, "utf8"));
		incomplete.completedLogDatabaseIds = [];
		writeFileSync(path, JSON.stringify(incomplete));
		const snapshot = Snapshot.open({ main: path });
		expect(validateSnapshot(snapshot).join()).toContain(
			"log coverage is incomplete",
		);
		snapshot.close();
	} finally {
		main.close();
		logs.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("reconciler reports newer updated rows as expected rereads without declaring cutover ready", async () => {
	const dir = mkdtempSync(join(tmpdir(), "paced-reconcile-"));
	const { main, logs, query } = fixture();
	try {
		main.exec("ALTER TABLE kernel_runtime_events DROP COLUMN updated_at");
		await capture(config, dir, {
			apiToken: "fixture",
			query,
			sleep: async () => {},
			log: () => {},
		});
		const snapshot = Snapshot.open({ main: join(dir, "manifest.json") });
		const bundles = new LocalBundleStore(join(dir, "bundles"));
		await exportAll(snapshot, bundles, config.assignments);
		const ref = { organizationId: "org-fixture", workspaceId: "ws" };
		const { tables } = await bundles.read(ref);
		const events = tables.get("kernel_runtime_events")!;
		events.push({ ...events[0]!, id: "new-event" });
		events[0]!.created_at = "2026-01-02T00:00:00.000Z";
		const outputs = tables.get("os_outputs")!;
		outputs[0]!.updated_at = new Date(Date.now() + 10000).toISOString();
		const report = await reconcileWorkspace(
			bundles,
			{
				kind: "local",
				open: async () => ({
					describe: async () => ({
						...ref,
						jurisdiction: "eu",
						createdAt: "",
						migrations: [],
					}),
					readRows: async (table: string) => ({
						rows: tables.get(table) ?? [],
						next: null,
					}),
					importRows: async () => {
						throw new Error("must not import");
					},
					close: async () => {},
				}),
			},
			ref,
		);
		expect(report.expectedRereads.some((r) => r.table === "os_outputs")).toBe(
			true,
		);
		expect(report.drift.some((r) => r.table === "os_outputs")).toBe(false);
		expect(
			report.expectedRereads.some(
				(r) =>
					r.table === "kernel_runtime_events" && r.reason.includes("rowid >"),
			),
		).toBe(true);
		expect(report.drift.some((r) => r.table === "kernel_runtime_events")).toBe(
			true,
		);
		expect(report.ok).toBe(false);
		snapshot.close();
	} finally {
		main.close();
		logs.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("completed capture retains freshness, bounds late inserts and stops permanent failures", async () => {
	const dir = mkdtempSync(join(tmpdir(), "paced-boundary-"));
	const { main, logs, query } = fixture();
	let inserted = false;
	try {
		const options = {
			apiToken: "fixture",
			sleep: async () => {},
			log: () => {},
		};
		const first = await capture(config, dir, {
			...options,
			query: async (db, sql, params) => {
				if (!inserted && sql.includes('FROM "os_outputs" WHERE rowid >')) {
					main.exec(
						"INSERT INTO os_outputs (id, organization_id, workspace_id) VALUES ('late', 'org-fixture', 'ws')",
					);
					inserted = true;
				}
				return query(db, sql, params);
			},
		});
		expect(first.proof.main.tables.os_outputs?.count).toBe(1);
		const again = await capture(config, dir, {
			...options,
			query: async () => {
				throw new Error("completed capture must not query production");
			},
		});
		expect(again.endedAt).toBe(first.endedAt);
		expect(again.requests).toBe(first.requests);
		const failureDir = join(dir, "failure");
		let calls = 0;
		await expect(
			capture(config, failureDir, {
				...options,
				query: async () => {
					calls++;
					return { ok: false, status: 403, detail: "denied" };
				},
			}),
		).rejects.toThrow("403");
		expect(calls).toBe(1);
	} finally {
		main.close();
		logs.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
