/**
 * `reconcile`: prove the copy. For every workspace, compare what the bundle
 * says was exported with what the object holds: row counts, one content hash
 * per table, the serving revision of every output, and the object's
 * jurisdiction. With the snapshot at hand, also prove nothing was left
 * behind: every source row is in exactly one bundle.
 *
 * Any difference is drift. The command prints the report and exits non-zero.
 */
import type { BundleStore } from "./bundle";
import { RowDigest } from "./rows";
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
	/** Source totals against bundle totals, when a snapshot was given. */
	totals: Array<{ table: string; source: number; bundled: number }>;
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
			const digest = new RowDigest(mapping.primaryKey);
			for (const row of actualRows) digest.add(row);
			rows += digest.count;
			const actualSha256 = digest.hex();
			// The bundle's own rows are hashed again rather than trusting the
			// manifest, so a bundle edited after export is caught too.
			const bundled = new RowDigest(mapping.primaryKey);
			for (const row of tables.get(mapping.table) ?? []) bundled.add(row);
			if (bundled.hex() !== expected.sha256 || bundled.count !== expected.count)
				problems.push(
					`bundle rows for ${mapping.table} no longer match its manifest`,
				);
			if (digest.count !== expected.count || actualSha256 !== expected.sha256)
				drift.push({
					table: mapping.table,
					expectedCount: expected.count,
					actualCount: digest.count,
					expectedSha256: expected.sha256,
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
		requiredJurisdiction?: string | null;
		onWorkspace?: (report: WorkspaceReport) => void;
	} = {},
): Promise<ReconcileReport> {
	const workspaces: WorkspaceReport[] = [];
	const bundled = new Map<string, number>();
	const refs = await bundles.list();
	for (const ref of refs) {
		const report = await reconcileWorkspace(
			bundles,
			stores,
			ref,
			options.requiredJurisdiction,
		);
		options.onWorkspace?.(report);
		workspaces.push(report);
		const { manifest } = await bundles.read(ref);
		for (const [table, summary] of Object.entries(manifest.tables))
			bundled.set(table, (bundled.get(table) ?? 0) + summary.count);
	}
	const problems: string[] = [];
	const totals: ReconcileReport["totals"] = [];
	if (options.snapshot) {
		const known = new Set(
			refs.map((r) => `${r.organizationId}/${r.workspaceId}`),
		);
		for (const ref of options.snapshot.listWorkspaces())
			if (!known.has(`${ref.organizationId}/${ref.workspaceId}`))
				problems.push(`workspace ${ref.workspaceId} has no bundle`);
		for (const mapping of WORKSPACE_TABLES) {
			const source = options.snapshot.countAll(mapping);
			const inBundles = bundled.get(mapping.table) ?? 0;
			totals.push({ table: mapping.table, source, bundled: inBundles });
			if (source !== inBundles)
				problems.push(
					`${mapping.table}: ${source} rows in the snapshot, ${inBundles} in bundles`,
				);
		}
	}
	return {
		ok: workspaces.every((w) => w.ok) && problems.length === 0,
		checkedAt: new Date().toISOString(),
		workspaces,
		totals,
		problems,
	};
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
			`${t.source === t.bundled ? "ok   " : "DRIFT"} total ${t.table}: snapshot=${t.source} bundles=${t.bundled}`,
		);
	for (const p of report.problems) lines.push(`DRIFT ${p}`);
	return lines.join("\n");
}
