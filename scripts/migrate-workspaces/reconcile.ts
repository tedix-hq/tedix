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
import { planObjectOwnedMerge, type MergePlan } from "./merge";
import { RowDigest, rowKey, type StoredRow } from "./rows";
import { refKey, type Scope } from "./scope";
import { logCoverageProblems } from "./snapshot-proof";
import type { Snapshot, WorkspaceRef } from "./source";
import {
	CONVERSATION_HAS_WORKSPACE,
	REQUIRED_JURISDICTION,
	WORKSPACE_TABLES,
	type WorkspaceAssignments,
} from "./tables";
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
	expectedRereads: Array<{ table: string; key: string; reason: string }>;
	objectNativeRows: Array<{ table: string; key: string; evidenceRef: string }>;
	/** Set for a merged object-owned workspace: what the object kept and what was left out. */
	merge?: Pick<MergePlan, "objectWins" | "notAdded"> & { evidenceRef: string };
	problems: string[];
	ms: number;
}

/**
 * An owner's decision about rows the ordinary comparison cannot explain.
 * Every row it covers is listed in the report with `evidenceRef`.
 */
export interface ApprovedAccounting {
	/** Where the decision is kept. */
	evidenceRef: string;
	/**
	 * The workspace is object-owned and was merged (`merge.ts`): differing rows
	 * stay as the object has them, object-only rows stay, and source rows the
	 * merge leaves out are listed. A source row the merge would still add is a
	 * problem.
	 */
	mergeObjectOwned?: boolean;
	/**
	 * Outputs the object holds that neither the source nor its output index
	 * names. They and their revisions stay as they are. Each must be in the
	 * object and absent from the bundle.
	 */
	objectNativeOutputIds?: readonly string[];
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
	knownDifferences: string[];
	problems: string[];
}

export async function reconcileWorkspace(
	bundles: BundleStore,
	stores: WorkspaceStoreFactory,
	ref: WorkspaceRef,
	requiredJurisdiction: string | null = REQUIRED_JURISDICTION,
	nativeEvidence?: ObjectNativeEvidence,
	approved?: ApprovedAccounting,
): Promise<WorkspaceReport> {
	const started = performance.now();
	const { manifest, tables } = await bundles.read(ref);
	const store = await stores.open(ref);
	const drift: TableDrift[] = [];
	const expectedRereads: WorkspaceReport["expectedRereads"] = [];
	const objectNativeRows: WorkspaceReport["objectNativeRows"] = [];
	const problems: string[] = [];
	let merge: WorkspaceReport["merge"];
	let rows = 0;
	let jurisdiction: string | null = null;
	try {
		const description = await store.describe();
		const objectRows = new Map<string, StoredRow[]>();
		for (const mapping of WORKSPACE_TABLES)
			objectRows.set(mapping.table, await readAllRows(store, mapping.table));
		// Rows an approved decision accounts for, per table, on each side.
		const accountedInObject = new Map<string, Set<string>>();
		const accountedInBundle = new Map<string, Set<string>>();
		const account = (
			side: Map<string, Set<string>>,
			table: string,
			key: string,
		) => side.set(table, (side.get(table) ?? new Set()).add(key));
		if (approved) {
			if (!approved.evidenceRef.trim())
				throw new Error("Approved accounting requires an evidence reference");
			if (approved.mergeObjectOwned) {
				if (description.outputAuthority !== "object")
					throw new Error(
						`Merge accounting refused: workspace ${ref.workspaceId} is not object-owned`,
					);
				const plan = planObjectOwnedMerge(tables, objectRows);
				for (const [table, missing] of plan.add)
					if (missing.length)
						problems.push(
							`${missing.length} source rows of ${table} are still to be added by the merge`,
						);
				for (const row of plan.objectWins) {
					account(accountedInObject, row.table, row.key);
					account(accountedInBundle, row.table, row.key);
				}
				for (const row of plan.notAdded)
					account(accountedInBundle, row.table, row.key);
				for (const row of plan.objectOnly) {
					account(accountedInObject, row.table, row.key);
					objectNativeRows.push({ ...row, evidenceRef: approved.evidenceRef });
				}
				merge = {
					objectWins: plan.objectWins,
					notAdded: plan.notAdded,
					evidenceRef: approved.evidenceRef,
				};
			}
			const nativeIds = new Set(approved.objectNativeOutputIds ?? []);
			if (nativeIds.size) {
				for (const row of tables.get("os_outputs") ?? [])
					if (nativeIds.has(String(row.id)))
						throw new Error(
							`Approved object-native output ${row.id} is present in source`,
						);
				const held = new Set<string>();
				for (const mapping of WORKSPACE_TABLES) {
					const column =
						mapping.table === "os_outputs"
							? "id"
							: mapping.table === "os_output_revisions"
								? "output_id"
								: null;
					if (!column) continue;
					for (const row of objectRows.get(mapping.table) ?? []) {
						if (
							!nativeIds.has(String(row[column])) ||
							row.organization_id !== ref.organizationId ||
							(column === "id" && row.workspace_id !== ref.workspaceId)
						)
							continue;
						const key = rowKey(row, mapping.primaryKey);
						if (accountedInObject.get(mapping.table)?.has(key)) continue;
						if (column === "id") held.add(String(row.id));
						account(accountedInObject, mapping.table, key);
						objectNativeRows.push({
							table: mapping.table,
							key,
							evidenceRef: approved.evidenceRef,
						});
					}
				}
				if (!approved.mergeObjectOwned)
					for (const id of nativeIds)
						if (!held.has(id))
							problems.push(
								`approved object-native output ${id} is not in the object`,
							);
			}
		}
		const native = new Map<string, string>();
		if (nativeEvidence) {
			if (
				description.outputAuthority !== "object" ||
				nativeEvidence.authorityBeforeStaging !== "object" ||
				!nativeEvidence.evidenceRef.trim()
			)
				throw new Error(
					"Object-native evidence requires prior and current object authority",
				);
			const bundledOutputs = new Set(
				(tables.get("os_outputs") ?? []).map((r) => String(r.id)),
			);
			for (const row of nativeEvidence.indexRows) {
				if (
					row.organizationId !== ref.organizationId ||
					row.workspaceId !== ref.workspaceId ||
					bundledOutputs.has(row.outputId) ||
					nativeEvidence.sourceOutputIds.includes(row.outputId)
				)
					throw new Error(
						"Object-native evidence has wrong scope or an output present in source",
					);
				native.set(row.revisionId, row.outputId);
			}
		}
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
			const accountedHere = accountedInObject.get(mapping.table);
			const accountedSource = accountedInBundle.get(mapping.table);
			const actualRows = objectRows
				.get(mapping.table)!
				.filter((row) => !accountedHere?.has(rowKey(row, mapping.primaryKey)))
				.filter((row) => {
					const isNative =
						mapping.table === "os_outputs"
							? [...native.values()].includes(String(row.id)) &&
								row.organization_id === ref.organizationId &&
								row.workspace_id === ref.workspaceId
							: mapping.table === "os_output_revisions" &&
								native.get(String(row.id)) === row.output_id &&
								row.organization_id === ref.organizationId;
					if (isNative)
						objectNativeRows.push({
							table: mapping.table,
							key: rowKey(row, mapping.primaryKey),
							evidenceRef: nativeEvidence!.evidenceRef,
						});
					return !isNative;
				});
			const everyBundledRow = tables.get(mapping.table) ?? [];
			const bundledRows = accountedSource
				? everyBundledRow.filter(
						(row) => !accountedSource.has(rowKey(row, mapping.primaryKey)),
					)
				: everyBundledRow;
			// Compare the columns the bundle carried: a row the export created
			// (a Home workspace) names only the columns it sets, and the object
			// fills the rest with defaults.
			const carried = new Set(
				everyBundledRow.flatMap((row) => Object.keys(row)),
			);
			const project = (row: StoredRow): StoredRow =>
				carried.size === 0
					? row
					: Object.fromEntries(
							Object.entries(row).filter(([column]) => carried.has(column)),
						);
			const mark =
				manifest.snapshot.capture?.highWater[manifest.snapshot.capture.main]?.[
					mapping.table
				];
			const pending = new Set<string>();
			if (mark && !mark.updatedAt) {
				const bundledKeys = new Set(
					bundledRows.map((row) => rowKey(row, mapping.primaryKey)),
				);
				for (const row of actualRows) {
					const key = rowKey(row, mapping.primaryKey);
					if (!bundledKeys.has(key)) pending.add(key);
				}
			}
			if (mark?.updatedAt) {
				for (const row of [...actualRows, ...bundledRows]) {
					if (
						typeof row.updated_at === "string" &&
						Date.parse(row.updated_at) > Date.parse(mark.updatedAt)
					)
						pending.add(rowKey(row, mapping.primaryKey));
				}
			}
			for (const key of pending)
				expectedRereads.push({
					table: mapping.table,
					key,
					reason: mark?.updatedAt
						? "updated after capture high-water mark; re-read source before cutover"
						: `row absent from capture; re-read source to verify rowid > ${mark?.rowid} before cutover`,
				});
			const digest = new RowDigest(mapping.primaryKey);
			for (const row of actualRows)
				if (!pending.has(rowKey(row, mapping.primaryKey)))
					digest.add(project(row));
			rows += digest.count;
			const actualSha256 = digest.hex();
			// The bundle's own rows are hashed again rather than trusting the
			// manifest, so a bundle edited after export is caught too.
			const bundled = new RowDigest(mapping.primaryKey);
			for (const row of everyBundledRow) bundled.add(row);
			if (bundled.hex() !== expected.sha256 || bundled.count !== expected.count)
				problems.push(
					`bundle rows for ${mapping.table} no longer match its manifest`,
				);
			const stable = new RowDigest(mapping.primaryKey);
			for (const row of bundledRows)
				if (!pending.has(rowKey(row, mapping.primaryKey))) stable.add(row);
			const expectedSha256 = stable.hex();
			if (digest.count !== stable.count || actualSha256 !== expectedSha256)
				drift.push({
					table: mapping.table,
					expectedCount: stable.count,
					actualCount: digest.count,
					expectedSha256,
					actualSha256,
				});
			if (mapping.table === "os_outputs")
				checkOutputHeads(
					manifest.outputHeads.filter((head) => {
						const key = rowKey({ id: head.outputId }, mapping.primaryKey);
						return !pending.has(key) && !accountedSource?.has(key);
					}),
					actualRows,
					objectRows.get("os_output_revisions")!,
					problems,
				);
		}
	} finally {
		await store.close();
	}
	return {
		...ref,
		ok:
			drift.length === 0 &&
			problems.length === 0 &&
			expectedRereads.length === 0,
		jurisdiction,
		rows,
		drift,
		expectedRereads,
		objectNativeRows,
		...(merge ? { merge } : {}),
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

/** Current, scoped source read plus retained authority receipt; never a blanket extra-row exemption. */
export interface ObjectNativeEvidence {
	authorityBeforeStaging: "object";
	evidenceRef: string;
	sourceOutputIds: string[];
	indexRows: Array<{
		organizationId: string;
		workspaceId: string;
		outputId: string;
		revisionId: string;
	}>;
}

export async function reconcileAll(
	bundles: BundleStore,
	stores: WorkspaceStoreFactory,
	options: {
		snapshot?: Snapshot;
		scope?: Scope;
		requiredJurisdiction?: string | null;
		onWorkspace?: (report: WorkspaceReport) => void;
		objectNativeEvidence?: (
			ref: WorkspaceRef,
		) => Promise<ObjectNativeEvidence | undefined>;
		/** Owner-approved accounting per workspace; see {@link ApprovedAccounting}. */
		approvedAccounting?: (ref: WorkspaceRef) => ApprovedAccounting | undefined;
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
			await options.objectNativeEvidence?.(ref),
			options.approvedAccounting?.(ref),
		);
		options.onWorkspace?.(report);
		workspaces.push(report);
	}
	const coverage = options.snapshot
		? await snapshotCoverage(bundles, options.snapshot, options.scope)
		: { totals: [], problems: [], knownDifferences: [] };
	return {
		ok: workspaces.every((w) => w.ok) && coverage.problems.length === 0,
		checkedAt: new Date().toISOString(),
		workspaces,
		totals: coverage.totals,
		knownDifferences: coverage.knownDifferences,
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
): Promise<Pick<ReconcileReport, "totals" | "problems" | "knownDifferences">> {
	const problems = logCoverageProblems(snapshot);
	const knownDifferences: string[] = [];
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
		const history = runsWithoutHistory(
			ref,
			tables,
			manifest.assignments?.retainedHistory,
		);
		problems.push(...history.problems);
		knownDifferences.push(...history.knownDifferences);
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
	for (const row of snapshot.main
		.prepare(
			`SELECT id, organization_id, workspace_id FROM kernel_conversations WHERE workspace_id IS NOT NULL AND NOT (${CONVERSATION_HAS_WORKSPACE}) ORDER BY organization_id, id`,
		)
		.all()) {
		if (scope && !scope.organizations.has(String(row.organization_id)))
			continue;
		knownDifferences.push(
			`${row.organization_id}: conversation ${row.id} and its dependent rows stay in main/logs; workspace ${row.workspace_id} no longer exists`,
		);
	}
	return { totals, problems, knownDifferences };
}

/** Runs that recorded events (`latest_event_at`) but whose events are in no store. */
function runsWithoutHistory(
	ref: WorkspaceRef,
	tables: Map<string, StoredRow[]>,
	reviewed: WorkspaceAssignments[string]["retainedHistory"] = [],
): { problems: string[]; knownDifferences: string[] } {
	const problems: string[] = [];
	const knownDifferences: string[] = [];
	const withEvents = new Set(
		(tables.get("kernel_runtime_events") ?? []).map((row) =>
			String(row.run_id),
		),
	);
	for (const run of (tables.get("kernel_runtime_runs") ?? [])
		.filter(
			(run) =>
				run.latest_event_at !== null && run.latest_event_at !== undefined,
		)
		.filter((run) => !withEvents.has(String(run.id)))) {
		const decisions = reviewed.filter((entry) => entry.runId === run.id);
		const decision = decisions[0];
		if (
			decisions.length === 1 &&
			decision &&
			decision.latestEventAt === run.latest_event_at &&
			decision.reason.trim() &&
			decision.evidenceRef.trim()
		) {
			knownDifferences.push(
				`${refKey(ref)}: run ${run.id} has no events (latest ${run.latest_event_at}); ${decision.reason}; reviewed at ${decision.evidenceRef}`,
			);
		} else {
			problems.push(
				`${refKey(ref)}: run ${run.id} recorded events (latest ${run.latest_event_at}) but none is in the snapshot; a log partition is missing`,
			);
		}
	}
	return { problems, knownDifferences };
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
		for (const pending of w.expectedRereads)
			lines.push(
				`      RE-READ ${pending.table} ${pending.key}: ${pending.reason}`,
			);
		if (w.objectNativeRows.length)
			lines.push(
				`      object-native rows accounted for: ${w.objectNativeRows.length}`,
			);
		for (const kept of w.merge?.objectWins ?? [])
			lines.push(`      OBJECT WINS ${kept.table} ${kept.key}`);
		for (const left of w.merge?.notAdded ?? [])
			lines.push(`      NOT ADDED ${left.table} ${left.key}: ${left.reason}`);
		for (const p of w.problems) lines.push(`      ${p}`);
	}
	for (const t of report.totals)
		lines.push(
			`${t.source === t.bundled ? "ok   " : "DRIFT"} total ${t.table}: snapshot=${t.source} bundles=${t.bundled}${t.staying ? ` staying=${t.staying}` : ""}`,
		);
	for (const difference of report.knownDifferences)
		lines.push(`KNOWN ${difference}`);
	for (const p of report.problems) lines.push(`DRIFT ${p}`);
	return lines.join("\n");
}
