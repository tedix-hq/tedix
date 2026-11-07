/**
 * `rehearse`: the whole move on a copy, timed. Export every workspace from
 * the snapshot, import each into a fresh local object, reconcile, and print
 * the time each step took per workspace and in total. The local objects are
 * created from the object's migration chain; tables that chain does not
 * create yet are shaped from the snapshot's own definitions and listed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBundleStore } from "./bundle";
import { exportAll } from "./export";
import { importAll } from "./import";
import { reconcileAll, renderReport, type ReconcileReport } from "./reconcile";
import { hasTable, type Snapshot } from "./source";
import { WORKSPACE_TABLES, type WorkspaceAssignments } from "./tables";
import { localStoreFactory, LocalWorkspaceStore } from "./target";

export interface RehearsalTiming {
	organizationId: string;
	workspaceId: string;
	rows: number;
	exportMs: number;
	importMs: number;
	reconcileMs: number;
}

export interface RehearsalReport {
	ok: boolean;
	workspaces: RehearsalTiming[];
	totalMs: number;
	exportMs: number;
	importMs: number;
	reconcileMs: number;
	fallbackTables: string[];
	reconcile: ReconcileReport;
}

export async function rehearse(
	snapshot: Snapshot,
	assignments: WorkspaceAssignments,
	options: {
		workDir?: string;
		keep?: boolean;
		log?: (line: string) => void;
	} = {},
): Promise<RehearsalReport> {
	const workDir =
		options.workDir ??
		mkdtempSync(join(tmpdir(), "tedix-workspace-rehearsal-"));
	const log = options.log ?? (() => {});
	const bundles = new LocalBundleStore(join(workDir, "bundles"));
	const fallbackDdl = (table: string) => {
		for (const db of [snapshot.main, ...snapshot.logs]) {
			if (!hasTable(db, table)) continue;
			const row = db
				.prepare(
					"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
				)
				.get(table);
			if (row?.sql) return String(row.sql);
		}
		return null;
	};
	const stores = localStoreFactory(join(workDir, "objects"), { fallbackDdl });
	const timings = new Map<string, RehearsalTiming>();
	const key = (r: { organizationId: string; workspaceId: string }) =>
		`${r.organizationId}/${r.workspaceId}`;
	const started = performance.now();

	const exported = await exportAll(snapshot, bundles, assignments, (r) => {
		timings.set(key(r), {
			organizationId: r.organizationId,
			workspaceId: r.workspaceId,
			rows: Object.values(r.manifest.tables).reduce((n, t) => n + t.count, 0),
			exportMs: r.ms,
			importMs: 0,
			reconcileMs: 0,
		});
		log(`export   ${key(r)} ${r.ms.toFixed(0)}ms`);
	});
	const afterExport = performance.now();
	await importAll(bundles, stores, (r) => {
		timings.get(key(r))!.importMs = r.ms;
		log(`import   ${key(r)} ${r.ms.toFixed(0)}ms (${r.imported} rows)`);
	});
	const afterImport = performance.now();
	const reconcile = await reconcileAll(bundles, stores, {
		snapshot,
		onWorkspace: (r) => {
			timings.get(key(r))!.reconcileMs = r.ms;
			log(`reconcile ${key(r)} ${r.ok ? "ok" : "DRIFT"} ${r.ms.toFixed(0)}ms`);
		},
	});
	const finished = performance.now();

	// Which mapped tables the object's own migration chain does not create yet.
	const bare = new LocalWorkspaceStore(
		":memory:",
		exported[0] ?? { organizationId: "none", workspaceId: "none" },
	);
	const fallbackTables = new Set(
		WORKSPACE_TABLES.map((m) => m.table).filter(
			(table) => !hasTable(bare.db, table),
		),
	);
	await bare.close();
	if (!options.keep && !options.workDir)
		rmSync(workDir, { recursive: true, force: true });
	return {
		ok: reconcile.ok,
		workspaces: [...timings.values()],
		totalMs: finished - started,
		exportMs: afterExport - started,
		importMs: afterImport - afterExport,
		reconcileMs: finished - afterImport,
		fallbackTables: [...fallbackTables].sort(),
		reconcile,
	};
}

export function renderRehearsal(report: RehearsalReport): string {
	const lines = [
		`rehearsal ${report.ok ? "OK" : "DRIFT"}: ${report.workspaces.length} workspaces, ${report.workspaces.reduce((n, w) => n + w.rows, 0)} rows`,
		`total ${report.totalMs.toFixed(0)}ms = export ${report.exportMs.toFixed(0)}ms + import ${report.importMs.toFixed(0)}ms + reconcile ${report.reconcileMs.toFixed(0)}ms`,
		"",
		"organization/workspace | rows | export ms | import ms | reconcile ms",
	];
	for (const w of report.workspaces)
		lines.push(
			`${w.organizationId}/${w.workspaceId} | ${w.rows} | ${w.exportMs.toFixed(0)} | ${w.importMs.toFixed(0)} | ${w.reconcileMs.toFixed(0)}`,
		);
	if (report.fallbackTables.length)
		lines.push(
			"",
			`tables shaped from the snapshot because the object's migration chain does not create them yet: ${report.fallbackTables.join(", ")}`,
		);
	lines.push("", renderReport(report.reconcile));
	return lines.join("\n");
}
