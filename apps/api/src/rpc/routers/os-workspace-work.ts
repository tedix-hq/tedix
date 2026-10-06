import { implement } from "@orpc/server";
import { osWorkspacesContract } from "@tedix/api-contract/contracts/os-workspaces";
import {
	type OsWorkspaceProject,
	OsWorkspaceProjectSchema,
} from "@tedix/api-contract/schemas/os-workspaces";
import {
	createOsWorkspaceProject,
	getOsWorkspaceProject,
	listOsWorkspaceProjects,
	reactivateOsWorkspaceProject,
	removeOsWorkspaceProject,
} from "@tedix/db/queries/os-workspaces/projects";
import { getProjectById } from "@tedix/db/queries/projects";
import { createDbQueryClient } from "@tedix/db/query-client";
import type { OsWorkspaceProjectRow } from "@tedix/db/schema/os-workspaces";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
} from "../orpc";
import { OS_WORKSPACES_AUDIT, osAudit } from "../os-audit";
import {
	isUniqueConstraintError,
	requireWorkspace,
	resolveCreator,
} from "./os-workspaces-shared";

const os = implement(osWorkspacesContract).$context<BaseContext>();
const authed = os.use(withAuth).use(osAudit(OS_WORKSPACES_AUDIT));
const readWork = authed.use(AUTHZ.osRead).use(AUTHZ.objectiveRead);
const authorWork = authed.use(AUTHZ.osAuthor).use(AUTHZ.objectiveWrite);

const mapLink = (row: OsWorkspaceProjectRow): OsWorkspaceProject =>
	OsWorkspaceProjectSchema.parse(row);

const listProjects = readWork.work.listProjects.handler(
	async ({ input, context }) => {
		const workspace = await requireWorkspace(context, input.workspaceId);
		const rows = await listOsWorkspaceProjects(
			createDbQueryClient(context.env.DB),
			{
				organizationId: workspace.organizationId,
				workspaceId: workspace.id,
				status: input.status,
				limit: input.limit + 1,
			},
		);
		return {
			items: rows.slice(0, input.limit).map(mapLink),
			truncated: rows.length > input.limit,
		};
	},
);

const attachProject = authorWork.work.attachProject.handler(
	async ({ input, context }) => {
		const workspace = await requireWorkspace(context, input.workspaceId);
		const project = await getProjectById(context.db, input.projectId);
		if (!project || project.orgId !== workspace.organizationId) {
			throw createError(ErrorCodes.NOT_FOUND, "Work project not found");
		}
		const db = createDbQueryClient(context.env.DB);
		const existing = await getOsWorkspaceProject(db, {
			organizationId: workspace.organizationId,
			workspaceId: workspace.id,
			projectId: project.id,
		});
		if (existing?.status === "active") return { link: mapLink(existing) };
		const now = new Date().toISOString();
		if (existing) {
			const restored = await reactivateOsWorkspaceProject(db, {
				organizationId: workspace.organizationId,
				workspaceId: workspace.id,
				projectId: project.id,
				now,
			});
			if (restored) return { link: mapLink(restored) };
		}
		const creator = resolveCreator(context);
		try {
			return {
				link: mapLink(
					await createOsWorkspaceProject(db, {
						id: crypto.randomUUID(),
						organizationId: workspace.organizationId,
						workspaceId: workspace.id,
						projectId: project.id,
						status: "active",
						createdByKind: creator.kind,
						createdById: creator.id,
						createdAt: now,
						updatedAt: now,
						removedAt: null,
					}),
				),
			};
		} catch (error) {
			if (isUniqueConstraintError(error)) {
				throw createError(
					ErrorCodes.CONFLICT,
					"Work project link changed; reload",
				);
			}
			throw error;
		}
	},
);

const removeProject = authorWork.work.removeProject.handler(
	async ({ input, context }) => {
		const workspace = await requireWorkspace(context, input.workspaceId);
		const db = createDbQueryClient(context.env.DB);
		const current = await getOsWorkspaceProject(db, {
			organizationId: workspace.organizationId,
			workspaceId: workspace.id,
			projectId: input.projectId,
		});
		if (!current)
			throw createError(ErrorCodes.NOT_FOUND, "Work project link not found");
		if (current.status === "removed") return { link: mapLink(current) };
		const removed = await removeOsWorkspaceProject(db, {
			organizationId: workspace.organizationId,
			workspaceId: workspace.id,
			projectId: input.projectId,
			expectedUpdatedAt: input.expectedUpdatedAt,
			now: new Date().toISOString(),
		});
		if (!removed) {
			throw createError(
				ErrorCodes.CONFLICT,
				"Work project link changed; reload",
			);
		}
		return { link: mapLink(removed) };
	},
);

export const osWorkspaceWorkProcedures = {
	listProjects,
	attachProject,
	removeProject,
};
