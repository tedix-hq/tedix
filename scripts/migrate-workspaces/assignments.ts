/**
 * `assignments`: propose the per-organization choices the export needs,
 * from the snapshot, for a person to review and keep with the Work Item.
 * The default home is the organization's oldest active workspace; an
 * organization with no workspace gets no entry and is reported.
 */
import type { Snapshot } from "./source";
import { WORKSPACE_TABLES, type WorkspaceAssignments } from "./tables";

export interface AssignmentProposal {
	assignments: WorkspaceAssignments;
	/** Organizations that have rows to place and no workspace to place them in. */
	withoutWorkspace: string[];
}

export function proposeAssignments(snapshot: Snapshot): AssignmentProposal {
	const oldest = new Map<string, string>();
	for (const row of snapshot.main
		.prepare(
			"SELECT id, organization_id, status FROM os_workspaces ORDER BY organization_id, CASE WHEN status = 'active' THEN 0 ELSE 1 END, created_at, id",
		)
		.all())
		if (!oldest.has(String(row.organization_id)))
			oldest.set(String(row.organization_id), String(row.id));
	const needs = new Set<string>([
		...snapshot.unassignedOutputs().keys(),
		...WORKSPACE_TABLES.filter((m) => m.domain === "memory").flatMap((m) =>
			snapshot.organizationsWithRows(m.table),
		),
	]);
	const assignments: WorkspaceAssignments = {};
	const withoutWorkspace: string[] = [];
	for (const org of [...needs].sort()) {
		const home = oldest.get(org);
		if (!home) {
			withoutWorkspace.push(org);
			continue;
		}
		assignments[org] = { memoryHome: home, unassignedOutputsHome: home };
	}
	return { assignments, withoutWorkspace };
}
