import type { DbClient } from "@tedix/db/client";
import { listProjects } from "@tedix/db/queries/projects";
import { listOsWorkspaceProjects } from "@tedix/db/queries/os-workspaces/projects";

/**
 * Supply names and canonical IDs. When the selected workspace is linked to
 * exactly one active project, that project is the default destination for
 * Work the operator does not place elsewhere.
 */
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
	const activeIds = new Set(projects.data.map((project) => project.id));
	const [onlyLinked, ...otherLinked] = [...linkedIds];
	return JSON.stringify({
		projects: projects.data.map((project) => ({
			projectId: project.id,
			name: project.name,
			key: project.key,
			linkedToSelectedWorkspace: linkedIds.has(project.id),
		})),
		truncated: projects.total > projects.data.length,
		...(onlyLinked && otherLinked.length === 0 && activeIds.has(onlyLinked)
			? { workspaceDefaultProjectId: onlyLinked }
			: {}),
	});
}

/** The selected workspace's one linked project, from {@link readWorkCreateProjects}. */
export function workspaceDefaultProjectId(
	workProjects: string | null,
): string | null {
	if (!workProjects) return null;
	try {
		const id = (
			JSON.parse(workProjects) as { workspaceDefaultProjectId?: unknown }
		).workspaceDefaultProjectId;
		return typeof id === "string" && id.length > 0 ? id : null;
	} catch {
		return null;
	}
}
