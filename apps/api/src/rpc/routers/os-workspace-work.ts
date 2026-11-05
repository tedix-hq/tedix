import { implement } from "@orpc/server";
import { osWorkspacesContract } from "@tedix/api-contract/contracts/os-workspaces";
import {
	type OsWorkspaceProject,
	OsWorkspaceProjectSchema,
} from "@tedix/api-contract/schemas/os-workspaces";
import {
	getOsWorkspaceProject,
	listOsWorkspaceProjects,
	removeOsWorkspaceProject,
} from "@tedix/db/queries/os-workspaces/projects";
import {
	getOsWorkspaceSummary,
	parseOsWorkspaceSummaryPayload,
} from "@tedix/db/queries/os-workspaces/summaries";
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
import { scheduleOsWorkspaceSummaryPublish } from "../../services/workspace-summaries";
import {
	ensureWorkspaceProjectLink,
	requireWorkspace,
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
		const db = createDbQueryClient(context.env.DB);
		// The Work board reads the workspace's published summary row for active
		// links; it lags the link write by the queue lag (bounded seconds).
		// Anything the summary does not model — no row yet, or a `removed`
		// listing — reads the source table, and a miss queues the first
		// snapshot so the next read lands on the summary path.
		const summary = await getOsWorkspaceSummary(db, {
			organizationId: workspace.organizationId,
			workspaceId: workspace.id,
		});
		if (summary && (!input.status || input.status === "active")) {
			const links = parseOsWorkspaceSummaryPayload(summary).workLinks;
			return {
				items: links.slice(0, input.limit).map(mapLink),
				truncated: links.length > input.limit,
			};
		}
		if (!summary) {
			scheduleOsWorkspaceSummaryPublish(context, {
				organizationId: workspace.organizationId,
				workspaceId: workspace.id,
			});
		}
		const rows = await listOsWorkspaceProjects(db, {
			organizationId: workspace.organizationId,
			workspaceId: workspace.id,
			status: input.status,
			limit: input.limit + 1,
		});
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
		const { link } = await ensureWorkspaceProjectLink(context, {
			organizationId: workspace.organizationId,
			workspaceId: workspace.id,
			projectId: project.id,
		});
		scheduleOsWorkspaceSummaryPublish(context, {
			organizationId: workspace.organizationId,
			workspaceId: workspace.id,
		});
		return { link: mapLink(link) };
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
		scheduleOsWorkspaceSummaryPublish(context, {
			organizationId: workspace.organizationId,
			workspaceId: workspace.id,
		});
		return { link: mapLink(removed) };
	},
);

export const osWorkspaceWorkProcedures = {
	listProjects,
	attachProject,
	removeProject,
};
