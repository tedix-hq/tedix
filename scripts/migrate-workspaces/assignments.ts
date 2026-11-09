/**
 * `assignments`: propose the per-organization choices the export needs,
 * from the snapshot, for a person to review and keep with the Work Item.
 * Outputs without a workspace go to the organization's oldest active
 * workspace; a live organization with such outputs and no workspace gets a
 * new Home, and a deleted organization is reported.
 */
import type { Snapshot } from "./source";
import type { WorkspaceAssignments } from "./tables";

export interface AssignmentProposal {
	assignments: WorkspaceAssignments;
	/** Live organizations with outputs to place and no workspace: a Home is proposed for each. */
	withoutWorkspace: string[];
	/** Organizations that no longer exist but left outputs without a workspace. */
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
	const live = snapshot.liveOrganizations();
	const assignments: WorkspaceAssignments = {};
	const withoutWorkspace: string[] = [];
	const orphaned: string[] = [];
	for (const org of [...snapshot.unassignedOutputs().keys()].sort()) {
		const home = oldest.get(org);
		if (home) {
			assignments[org] = { unassignedOutputsHome: home };
			continue;
		}
		if (!live.has(org)) {
			orphaned.push(org);
			continue;
		}
		withoutWorkspace.push(org);
		assignments[org] = {
			unassignedOutputsHome: `home-${org}`,
			createHome: true,
		};
	}
	return { assignments, withoutWorkspace, orphaned };
}
