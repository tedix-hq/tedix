/**
 * `export`: read one workspace's rows from the snapshot and write its bundle.
 *
 * Outputs without a workspace go to the workspace named in the assignments
 * file; an organization with such rows and no assignment stops the export,
 * because a row left behind is a cutover failure, not a warning. Every
 * bundle carries the count and hash manifest of the snapshot it came from,
 * so `import` can prove it loads exactly that snapshot.
 */
import type { BundleManifest, BundleStore, TableSummary } from "./bundle";
import { RowDigest, type StoredRow } from "./rows";
import { snapshotManifest, type SnapshotManifest } from "./snapshot-proof";
import type { Snapshot, WorkspaceRef } from "./source";
import { refKey, type Scope } from "./scope";
import {
	WORKSPACE_TABLES,
	UNASSIGNED_OUTPUT,
	type TableMapping,
	type WorkspaceAssignments,
} from "./tables";

export interface ExportResult extends WorkspaceRef {
	manifest: BundleManifest;
	ms: number;
}

/** The rows one workspace takes, applying the organization's assignments. */
export function collectWorkspaceRows(
	snapshot: Snapshot,
	ref: WorkspaceRef,
	assignments: WorkspaceAssignments,
): { tables: Map<string, StoredRow[]>; reassigned: Map<string, number> } {
	const choice = assignments[ref.organizationId];
	const tables = new Map<string, StoredRow[]>();
	const reassigned = new Map<string, number>();
	for (const mapping of WORKSPACE_TABLES) {
		if (
			mapping.table === "os_workspaces" &&
			choice?.createHome &&
			choice.unassignedOutputsHome === ref.workspaceId
		) {
			tables.set(mapping.table, [homeWorkspaceRow(ref)]);
			reassigned.set(mapping.table, 1);
			continue;
		}
		const rows = snapshot.readRows(mapping, ref);
		if (choice?.unassignedOutputsHome === ref.workspaceId)
			rows.push(...unassignedRowsFor(snapshot, mapping, ref, reassigned));
		tables.set(mapping.table, rows);
	}
	return { tables, reassigned };
}

/** The directory row of a Home workspace created for an organization that had none. */
export function homeWorkspaceRow(ref: WorkspaceRef): StoredRow {
	const now = new Date().toISOString();
	return {
		id: ref.workspaceId,
		organization_id: ref.organizationId,
		name: "Home",
		description:
			"Created by the workspace migration for this organization's outputs",
		status: "active",
		created_by_kind: "system",
		created_by_id: "workspace-migration",
		created_at: now,
		updated_at: now,
	};
}

/** Outputs with `workspace_id IS NULL` and their revisions, rewritten to `ref`. */
function unassignedRowsFor(
	snapshot: Snapshot,
	mapping: TableMapping,
	ref: WorkspaceRef,
	reassigned: Map<string, number>,
): StoredRow[] {
	if (mapping.table !== "os_outputs" && mapping.table !== "os_output_revisions")
		return [];
	const sql =
		mapping.table === "os_outputs"
			? `SELECT * FROM os_outputs WHERE organization_id = @org AND ${UNASSIGNED_OUTPUT}`
			: `SELECT * FROM os_output_revisions WHERE organization_id = @org AND output_id IN (SELECT id FROM os_outputs WHERE organization_id = @org AND ${UNASSIGNED_OUTPUT})`;
	const rows = snapshot.main
		.prepare(sql)
		.all({ org: ref.organizationId }) as StoredRow[];
	if (mapping.workspaceColumn)
		for (const row of rows) row[mapping.workspaceColumn] = ref.workspaceId;
	reassigned.set(mapping.table, rows.length);
	return rows;
}

/** Stop before writing anything when an organization's choice is missing. */
export function checkAssignments(
	snapshot: Snapshot,
	assignments: WorkspaceAssignments,
	scope?: Scope,
): string[] {
	const problems: string[] = [];
	const workspaces = snapshot.listWorkspaces(assignments);
	const known = new Set(
		workspaces.map((w) => `${w.organizationId}/${w.workspaceId}`),
	);
	for (const [org, ids] of snapshot.unassignedOutputs()) {
		if (scope && !scope.organizations.has(org)) continue;
		const home = assignments[org]?.unassignedOutputsHome;
		if (!home)
			problems.push(
				`organization ${org}: ${ids.length} outputs have no workspace and no unassignedOutputsHome`,
			);
		else if (!known.has(`${org}/${home}`))
			problems.push(
				`organization ${org}: unassignedOutputsHome ${home} is not a workspace of that organization`,
			);
	}
	return problems;
}

export function outputHeads(
	tables: Map<string, StoredRow[]>,
): BundleManifest["outputHeads"] {
	const latest = new Map<string, number>();
	for (const revision of tables.get("os_output_revisions") ?? []) {
		const id = String(revision.output_id);
		latest.set(id, Math.max(latest.get(id) ?? -1, Number(revision.revision)));
	}
	return (tables.get("os_outputs") ?? [])
		.map((output) => ({
			outputId: String(output.id),
			currentRevisionId:
				output.current_revision_id === null
					? null
					: String(output.current_revision_id),
			latestRevision: latest.get(String(output.id)) ?? null,
		}))
		.sort((a, b) => (a.outputId < b.outputId ? -1 : 1));
}

export async function exportWorkspace(
	snapshot: Snapshot,
	bundles: BundleStore,
	ref: WorkspaceRef,
	assignments: WorkspaceAssignments,
	snapshotProof: SnapshotManifest,
): Promise<ExportResult> {
	const started = performance.now();
	const { tables, reassigned } = collectWorkspaceRows(
		snapshot,
		ref,
		assignments,
	);
	const summaries: Record<string, TableSummary> = {};
	for (const mapping of WORKSPACE_TABLES) {
		const digest = new RowDigest(mapping.primaryKey);
		for (const row of tables.get(mapping.table) ?? []) digest.add(row);
		summaries[mapping.table] = {
			count: digest.count,
			sha256: digest.hex(),
			reassigned: reassigned.get(mapping.table) ?? 0,
		};
	}
	const manifest: BundleManifest = {
		version: 1,
		...ref,
		exportedAt: new Date().toISOString(),
		assignments: assignments[ref.organizationId] ?? null,
		tables: summaries,
		outputHeads: outputHeads(tables),
		snapshot: snapshotProof,
	};
	await bundles.write(ref, manifest, tables);
	return { ...ref, manifest, ms: performance.now() - started };
}

export async function exportAll(
	snapshot: Snapshot,
	bundles: BundleStore,
	assignments: WorkspaceAssignments,
	options: {
		scope?: Scope;
		onWorkspace?: (result: ExportResult) => void;
	} = {},
): Promise<ExportResult[]> {
	const { scope, onWorkspace } = options;
	const problems = checkAssignments(snapshot, assignments, scope);
	const refs = snapshot
		.listWorkspaces(assignments)
		.filter((ref) => !scope || scope.includes(ref));
	if (scope)
		for (const key of scope.keys)
			if (!refs.some((ref) => refKey(ref) === key))
				problems.push(`scope names ${key}, which is not a workspace`);
	if (problems.length)
		throw new Error(`Export refused:\n  ${problems.join("\n  ")}`);
	const proof = snapshotManifest(snapshot);
	const results: ExportResult[] = [];
	for (const ref of refs) {
		const result = await exportWorkspace(
			snapshot,
			bundles,
			ref,
			assignments,
			proof,
		);
		onWorkspace?.(result);
		results.push(result);
	}
	return results;
}
