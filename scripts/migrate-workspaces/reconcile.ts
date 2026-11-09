/**
 * `reconcile`: prove the copy. For every workspace, compare what the bundle
 * says was exported with what the object holds: row counts, one content hash
 * per table, the serving revision of every output, and the object's
 * jurisdiction. With the snapshot at hand, also prove nothing was left
 * behind: every source row is in exactly one bundle, and the log partitions
 * cover every run's history ({@link snapshotCoverage}; `import` runs the
 * same check before it writes).
 *
 * Any difference is drift. The command prints the report and exits non-zero.
 */
import type { BundleStore } from "./bundle";
import { collectWorkspaceRows } from "./export";
import { RowDigest, type StoredRow } from "./rows";
import { refKey, type Scope } from "./scope";
import { logCoverageProblems } from "./snapshot-proof";
import type { Snapshot, WorkspaceRef } from "./source";
import { REQUIRED_JURISDICTION, WORKSPACE_TABLES } from "./tables";
import { readAllRows, type WorkspaceStoreFactory } from "./target";

export interface TableDrift {
	table: string;
	expectedCount: number;
	actualCount: number;
	expectedSha256: string;
	actualSha256: string;
}

export interface WorkspaceReport extends WorkspaceRef {
	ok: boolean;
	jurisdiction: string | null;
	rows: number;
	drift: TableDrift[];
	problems: string[];
	ms: number;
}

export interface ReconcileReport {
	ok: boolean;
	checkedAt: string;
	workspaces: WorkspaceReport[];
	/** Source totals against bundle totals, when a snapshot was given; `staying` rows are left behind on purpose. */
	totals: Array<{
		table: string;
		source: number;
		bundled: number;
		staying: number;
	}>;
	problems: string[];
}

export async function reconcileWorkspace(
	bundles: BundleStore,
	stores: WorkspaceStoreFactory,
	ref: WorkspaceRef,
	requiredJurisdiction: string | null = REQUIRED_JURISDICTION,
): Promise<WorkspaceReport> {
	const started = performance.now();
	const { manifest, tables } = await bundles.read(ref);
	const store = await stores.open(ref);
	const drift: TableDrift[] = [];
	const problems: string[] = [];
	let rows = 0;
	let jurisdiction: string | null = null;
	try {
		const description = await store.describe();
		jurisdiction = description.jurisdiction;
		if (
			description.organizationId !== ref.organizationId ||
			description.workspaceId !== ref.workspaceId
		)
			problems.push("object identity does not match the workspace");
		if (
			requiredJurisdiction &&
			description.jurisdiction !== requiredJurisdiction
		)
			problems.push(
				`jurisdiction is ${description.jurisdiction ?? "unset"}, expected ${requiredJurisdiction}`,
			);
		for (const mapping of WORKSPACE_TABLES) {
			const expected = manifest.tables[mapping.table];
			if (!expected) {
				problems.push(`bundle has no summary for ${mapping.table}`);
				continue;
			}
			const actualRows = await readAllRows(store, mapping.table);
			const bundledRows = tables.get(mapping.table) ?? [];
			// Compare the columns the bundle carried: a row the export created
			// (a Home workspace) names only the columns it sets, and the object
			// fills the rest with defaults.
			const carried = new Set(bundledRows.flatMap((row) => Object.keys(row)));
			const project = (row: StoredRow): StoredRow =>
				carried.size === 0
					? row
					: Object.fromEntries(
							Object.entries(row).filter(([column]) => carried.has(column)),
						);
			const digest = new RowDigest(mapping.primaryKey);
			for (const row of actualRows) digest.add(project(row));
			rows += digest.count;
			const actualSha256 = digest.hex();
			// The bundle's own rows are hashed again rather than trusting the
			// manifest, so a bundle edited after export is caught too.
			const bundled = new RowDigest(mapping.primaryKey);
			for (const row of bundledRows) bundled.add(row);
			if (bundled.hex() !== expected.sha256 || bundled.count !== expected.count)
				problems.push(
					`bundle rows for ${mapping.table} no longer match its manifest`,
				);
			const expectedSha256 = expected.sha256;
			if (digest.count !== expected.count || actualSha256 !== expectedSha256)
				drift.push({
					table: mapping.table,
					expectedCount: expected.count,
					actualCount: digest.count,
					expectedSha256,
					actualSha256,
				});
			if (mapping.table === "os_outputs")
				checkOutputHeads(
					manifest.outputHeads,
					actualRows,
					await readAllRows(store, "os_output_revisions"),
					problems,
				);
		}
	} finally {
		await store.close();
	}
	return {
		...ref,
		ok: drift.length === 0 && problems.length === 0,
		jurisdiction,
		rows,
		drift,
		problems,
		ms: performance.now() - started,
	};
}

function checkOutputHeads(
	heads: Array<{
		outputId: string;
		currentRevisionId: string | null;
		latestRevision: number | null;
	}>,
	outputs: Array<Record<string, unknown>>,
	revisions: Array<Record<string, unknown>>,
	problems: string[],
): void {
	const revisionIds = new Set(revisions.map((r) => String(r.id)));
	const latest = new Map<string, number>();
	for (const revision of revisions) {
		const id = String(revision.output_id);
		latest.set(id, Math.max(latest.get(id) ?? -1, Number(revision.revision)));
	}
	const current = new Map(
		outputs.map((o) => [
			String(o.id),
			o.current_revision_id === null ? null : String(o.current_revision_id),
		]),
	);
	for (const head of heads) {
		if (!current.has(head.outputId)) {
			problems.push(`output ${head.outputId} missing in the object`);
			continue;
		}
		if (current.get(head.outputId) !== head.currentRevisionId)
			problems.push(
				`output ${head.outputId} serves ${current.get(head.outputId)}, expected ${head.currentRevisionId}`,
			);
		if (head.currentRevisionId && !revisionIds.has(head.currentRevisionId))
			problems.push(
				`output ${head.outputId}: serving revision ${head.currentRevisionId} is not in the object`,
			);
		if ((latest.get(head.outputId) ?? null) !== head.latestRevision)
			problems.push(
				`output ${head.outputId}: latest revision is ${latest.get(head.outputId) ?? "none"}, expected ${head.latestRevision ?? "none"}`,
			);
	}
}

export async function reconcileAll(
	bundles: BundleStore,
	stores: WorkspaceStoreFactory,
	options: {
		snapshot?: Snapshot;
		scope?: Scope;
		requiredJurisdiction?: string | null;
		onWorkspace?: (report: WorkspaceReport) => void;
	} = {},
): Promise<ReconcileReport> {
	const workspaces: WorkspaceReport[] = [];
	const refs = await scopedRefs(bundles, options.scope);
	for (const ref of refs) {
		const report = await reconcileWorkspace(
			bundles,
			stores,
			ref,
			options.requiredJurisdiction,
		);
		options.onWorkspace?.(report);
		workspaces.push(report);
	}
	const coverage = options.snapshot
		? await snapshotCoverage(bundles, options.snapshot, options.scope)
		: { totals: [], problems: [] };
	return {
		ok: workspaces.every((w) => w.ok) && coverage.problems.length === 0,
		checkedAt: new Date().toISOString(),
		workspaces,
		totals: coverage.totals,
		problems: coverage.problems,
	};
}

/** The bundles a run covers: all of them, or exactly the scope's workspaces. */
export async function scopedRefs(
	bundles: BundleStore,
	scope?: Scope,
): Promise<WorkspaceRef[]> {
	const refs = await bundles.list();
	if (!scope) return refs;
	const listed = new Set(refs.map(refKey));
	for (const key of scope.keys)
		if (!listed.has(key))
			throw new Error(`scope names ${key}, which has no bundle`);
	return refs.filter((ref) => scope.includes(ref));
}

/**
 * Prove the bundles hold everything the snapshot says should move, and that
 * the log partitions cover every run's history.
 *
 * Without a scope, every workspace in the snapshot needs a bundle and the
 * moved rows of each table, summed over bundles, equal the snapshot's. With
 * a scope, each scoped workspace's rows are collected from the snapshot
 * again and must match its bundle row for row. Either way a run that
 * recorded events must have them: none missing from main or the partitions.
 */
export async function snapshotCoverage(
	bundles: BundleStore,
	snapshot: Snapshot,
	scope?: Scope,
): Promise<Pick<ReconcileReport, "totals" | "problems">> {
	const problems = logCoverageProblems(snapshot);
	const totals: ReconcileReport["totals"] = [];
	const refs = await scopedRefs(bundles, scope);
	const bundled = new Map<string, number>();
	const expected = new Map<string, number>();
	let createdHomes = 0;
	for (const ref of refs) {
		const { manifest, tables } = await bundles.read(ref);
		if (
			manifest.assignments?.createHome &&
			manifest.assignments.unassignedOutputsHome === ref.workspaceId
		)
			createdHomes += 1;
		for (const [table, summary] of Object.entries(manifest.tables))
			bundled.set(table, (bundled.get(table) ?? 0) + summary.count);
		problems.push(...runsWithoutHistory(ref, tables));
		if (!scope) continue;
		const fresh = collectWorkspaceRows(snapshot, ref, {
			...(manifest.assignments
				? { [ref.organizationId]: manifest.assignments }
				: {}),
		}).tables;
		for (const mapping of WORKSPACE_TABLES) {
			const digest = new RowDigest(mapping.primaryKey);
			// A created Home's directory row carries the export's clock; compare its id only.
			for (const row of fresh.get(mapping.table) ?? [])
				digest.add(
					mapping.table === "os_workspaces" && manifest.assignments?.createHome
						? { id: row.id ?? null }
						: row,
				);
			expected.set(
				mapping.table,
				(expected.get(mapping.table) ?? 0) + digest.count,
			);
			const summary = manifest.tables[mapping.table];
			const sameRows =
				mapping.table === "os_workspaces" && manifest.assignments?.createHome
					? summary?.count === digest.count
					: summary?.sha256 === digest.hex();
			if (summary?.count !== digest.count || !sameRows)
				problems.push(
					`${refKey(ref)} ${mapping.table}: the snapshot holds ${digest.count} rows, the bundle ${summary?.count ?? 0} or other content`,
				);
		}
	}
	if (!scope) {
		const known = new Set(refs.map(refKey));
		for (const ref of snapshot.listWorkspaces())
			if (!known.has(refKey(ref)))
				problems.push(`workspace ${ref.workspaceId} has no bundle`);
	}
	for (const mapping of WORKSPACE_TABLES) {
		// A Home created during the export is in its bundle but not in the snapshot.
		const source = scope
			? (expected.get(mapping.table) ?? 0)
			: snapshot.countAll(mapping) +
				(mapping.table === "os_workspaces" ? createdHomes : 0);
		const inBundles = bundled.get(mapping.table) ?? 0;
		totals.push({
			table: mapping.table,
			source,
			bundled: inBundles,
			staying: scope ? 0 : snapshot.countStaying(mapping),
		});
		if (source !== inBundles)
			problems.push(
				`${mapping.table}: ${source} rows in the snapshot, ${inBundles} in bundles`,
			);
	}
	return { totals, problems };
}

/** Runs that recorded events (`latest_event_at`) but whose events are in no store. */
function runsWithoutHistory(
	ref: WorkspaceRef,
	tables: Map<string, StoredRow[]>,
): string[] {
	const withEvents = new Set(
		(tables.get("kernel_runtime_events") ?? []).map((row) =>
			String(row.run_id),
		),
	);
	return (tables.get("kernel_runtime_runs") ?? [])
		.filter(
			(run) =>
				run.latest_event_at !== null && run.latest_event_at !== undefined,
		)
		.filter((run) => !withEvents.has(String(run.id)))
		.map(
			(run) =>
				`${refKey(ref)}: run ${run.id} recorded events (latest ${run.latest_event_at}) but none is in the snapshot; a log partition is missing`,
		);
}

export function renderReport(report: ReconcileReport): string {
	const lines: string[] = [];
	lines.push(
		`workspace reconciliation ${report.ok ? "OK" : "DRIFT"} at ${report.checkedAt}`,
	);
	for (const w of report.workspaces) {
		lines.push(
			`${w.ok ? "ok   " : "DRIFT"} ${w.organizationId}/${w.workspaceId} rows=${w.rows} ${w.ms.toFixed(0)}ms`,
		);
		for (const d of w.drift)
			lines.push(
				`      ${d.table}: count ${d.expectedCount} -> ${d.actualCount}, sha ${d.expectedSha256.slice(0, 12)} -> ${d.actualSha256.slice(0, 12)}`,
			);
		for (const p of w.problems) lines.push(`      ${p}`);
	}
	for (const t of report.totals)
		lines.push(
			`${t.source === t.bundled ? "ok   " : "DRIFT"} total ${t.table}: snapshot=${t.source} bundles=${t.bundled}${t.staying ? ` staying=${t.staying}` : ""}`,
		);
	for (const p of report.problems) lines.push(`DRIFT ${p}`);
	return lines.join("\n");
}
