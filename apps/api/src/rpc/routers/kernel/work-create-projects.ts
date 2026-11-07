import type { DbClient } from "@tedix/db/client";
import { listProjects } from "@tedix/db/queries/projects";

/** Supply names and canonical IDs of the organization's active projects. */
export async function readWorkCreateProjects(
	db: DbClient,
	scope: { organizationId: string },
): Promise<string> {
	const projects = await listProjects(db, {
		orgId: scope.organizationId,
		status: "active",
		limit: 100,
	});
	return JSON.stringify({
		projects: projects.data.map((project) => ({
			projectId: project.id,
			name: project.name,
			key: project.key,
		})),
		truncated: projects.total > projects.data.length,
	});
}

/** A project's name from {@link readWorkCreateProjects}, by its id. */
export function workCreateProjectName(
	workProjects: string | null,
	projectId: unknown,
): string | null {
	if (!workProjects || typeof projectId !== "string") return null;
	try {
		const project = (
			JSON.parse(workProjects) as {
				projects?: Array<{ projectId?: unknown; name?: unknown }>;
			}
		).projects?.find((entry) => entry.projectId === projectId);
		return typeof project?.name === "string" && project.name.trim()
			? project.name.trim()
			: null;
	} catch {
		return null;
	}
}
