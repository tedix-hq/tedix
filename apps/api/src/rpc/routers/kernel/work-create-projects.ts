import type { DbClient } from "@tedix/db/client";
import { listProjects } from "@tedix/db/queries/projects";
import { listOsWorkspaceProjects } from "@tedix/db/queries/os-workspaces/projects";

/** Supply names and canonical IDs without choosing a destination for the operator. */
export async function readWorkCreateProjects(
	db: DbClient,
	scope: { organizationId: string; workspaceId?: string },
): Promise<string> {
	const [projects, links] = await Promise.all([
		listProjects(db, {
			orgId: scope.organizationId,
			status: "active",
			limit: 100,
		}),
		scope.workspaceId
			? listOsWorkspaceProjects(db, {
					organizationId: scope.organizationId,
					workspaceId: scope.workspaceId,
					status: "active",
					limit: 100,
				})
			: [],
	]);
	const linkedIds = new Set(links.map((link) => link.projectId));
	return JSON.stringify({
		projects: projects.data.map((project) => ({
			projectId: project.id,
			name: project.name,
			key: project.key,
			linkedToSelectedWorkspace: linkedIds.has(project.id),
		})),
		truncated: projects.total > projects.data.length,
	});
}
