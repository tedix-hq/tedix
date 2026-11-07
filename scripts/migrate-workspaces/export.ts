/**
 * `export`: read one workspace's rows from the snapshot and write its bundle.
 *
 * Outputs without a workspace and the organization's memory go to the
 * workspaces named in the assignments file; an organization with such rows
 * and no assignment stops the export, because a row left behind is a cutover
 * failure, not a warning.
 */
import type { BundleManifest, BundleStore, TableSummary } from "./bundle";
import { RowDigest, type StoredRow } from "./rows";
import type { Snapshot, WorkspaceRef } from "./source";
import {
	WORKSPACE_TABLES,
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
		if (mapping.domain === "memory") {
			tables.set(
				mapping.table,
				choice?.memoryHome === ref.workspaceId
					? snapshot.readRows(mapping, ref)
					: [],
			);
			continue;
		}
		const rows = snapshot.readRows(mapping, ref);
		if (choice?.unassignedOutputsHome === ref.workspaceId)
			rows.push(...unassignedRowsFor(snapshot, mapping, ref, reassigned));
		tables.set(mapping.table, rows);
	}
	return { tables, reassigned };
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
			? "SELECT * FROM os_outputs WHERE organization_id = @org AND workspace_id IS NULL"
			: "SELECT * FROM os_output_revisions WHERE organization_id = @org AND output_id IN (SELECT id FROM os_outputs WHERE organization_id = @org AND workspace_id IS NULL)";
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
): string[] {
	const problems: string[] = [];
	const workspaces = snapshot.listWorkspaces();
	const known = new Set(
		workspaces.map((w) => `${w.organizationId}/${w.workspaceId}`),
	);
	for (const [org, ids] of snapshot.unassignedOutputs()) {
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
	const organizationsWithMemory = new Set(
		WORKSPACE_TABLES.filter((m) => m.domain === "memory").flatMap((m) =>
			snapshot.organizationsWithRows(m.table),
		),
	);
	for (const org of [...organizationsWithMemory].sort()) {
		const home = assignments[org]?.memoryHome;
		if (!home)
			problems.push(
				`organization ${org}: memory rows exist and no memoryHome is assigned`,
			);
		else if (!known.has(`${org}/${home}`))
			problems.push(
				`organization ${org}: memoryHome ${home} is not a workspace of that organization`,
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
	};
	await bundles.write(ref, manifest, tables);
	return { ...ref, manifest, ms: performance.now() - started };
}

export async function exportAll(
	snapshot: Snapshot,
	bundles: BundleStore,
	assignments: WorkspaceAssignments,
	onWorkspace?: (result: ExportResult) => void,
): Promise<ExportResult[]> {
	const problems = checkAssignments(snapshot, assignments);
	if (problems.length)
		throw new Error(`Export refused:\n  ${problems.join("\n  ")}`);
	const results: ExportResult[] = [];
	for (const ref of snapshot.listWorkspaces()) {
		const result = await exportWorkspace(snapshot, bundles, ref, assignments);
		onWorkspace?.(result);
		results.push(result);
	}
	return results;
}
