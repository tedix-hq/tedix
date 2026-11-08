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
	/** Live organizations with rows to place and no workspace: a Home is proposed for each. */
	withoutWorkspace: string[];
	/** Organizations that no longer exist but left memory rows; those rows stay behind. */
	orphaned: string[];
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
	const live = snapshot.liveOrganizations();
	const assignments: WorkspaceAssignments = {};
	const withoutWorkspace: string[] = [];
	const orphaned: string[] = [];
	for (const org of [...needs].sort()) {
		const home = oldest.get(org);
		if (home) {
			assignments[org] = { memoryHome: home, unassignedOutputsHome: home };
			continue;
		}
		if (!live.has(org)) {
			orphaned.push(org);
			continue;
		}
		withoutWorkspace.push(org);
		assignments[org] = {
			memoryHome: `home-${org}`,
			unassignedOutputsHome: `home-${org}`,
			createHome: true,
		};
	}
	return { assignments, withoutWorkspace, orphaned };
}
