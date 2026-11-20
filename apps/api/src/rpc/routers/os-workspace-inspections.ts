/**
 * Read-only workspace inspection by an organization owner or admin: listing
 * what can be inspected, recording an inspection, and showing members who
 * inspected their workspace. What an inspection lets its author read is
 * decided in `services/os-workspace-inspection.ts`.
 */
import { implement } from "@orpc/server";
import { osWorkspacesContract } from "@tedix/api-contract/contracts/os-workspaces";
import { OS_WORKSPACE_INSPECTION_MS } from "@tedix/api-contract/schemas/os-workspace-inspections";
import {
	isOrganizationInspector,
	listOsWorkspaceInspections,
	listOsWorkspacesForInspection,
	recordOsWorkspaceInspection,
} from "@tedix/db/queries/os-workspace-inspections";
import { getOsWorkspace } from "@tedix/db/queries/os-workspaces/workspaces";
import { withOrg } from "../org-scope";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
	withAuthorization,
} from "../orpc";
import { queryDb, requireWorkspace } from "./os-workspaces-shared";

const os = implement(osWorkspacesContract).$context<BaseContext>();
const authed = os.use(withAuth);

/** The signed-in person, when they are an active owner or admin here. */
async function requireInspector(
	context: BaseContext & { organizationId: string },
): Promise<string> {
	const userId = context.authType === "user" ? context.user?.sub : undefined;
	if (
		!userId ||
		!(await isOrganizationInspector(
			queryDb(context),
			context.organizationId,
			userId,
		))
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Only an organization owner or admin can inspect workspaces",
		);
	return userId;
}

const workspaces = authed.inspections.workspaces
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"Only a signed-in active owner or admin of the organization; the handler reads their live membership.",
			},
			"apps:read",
		),
	)
	.use(withOrg)
	.handler(async ({ context }) => {
		await requireInspector(context);
		const rows = await listOsWorkspacesForInspection(
			queryDb(context),
			context.organizationId,
		);
		return { items: rows };
	});

const start = authed.inspections.start
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"Only a signed-in active owner or admin of the organization; the handler reads their live membership.",
			},
			"apps:write",
		),
	)
	.use(withOrg)
	.handler(async ({ input, context }) => {
		const userId = await requireInspector(context);
		const workspace = await getOsWorkspace(queryDb(context), {
			organizationId: context.organizationId,
			workspaceId: input.workspaceId,
		});
		if (!workspace || workspace.status !== "active")
			throw createError(ErrorCodes.NOT_FOUND, "Workspace not found");
		const reason = input.reason?.trim();
		// Awaited and never caught: without this row there is no inspection.
		const { startedAt } = await recordOsWorkspaceInspection(context.db, {
			organizationId: context.organizationId,
			workspaceId: workspace.id,
			userId,
			metadata: {
				workspaceName: workspace.name,
				visibility: workspace.visibility,
				...(reason ? { reason } : {}),
			},
			ipAddress: context.headers?.get("CF-Connecting-IP"),
			userAgent: context.headers?.get("User-Agent"),
		});
		return {
			workspaceId: workspace.id,
			startedAt: startedAt.toISOString(),
			endsAt: new Date(
				startedAt.getTime() + OS_WORKSPACE_INSPECTION_MS,
			).toISOString(),
		};
	});

const history = authed.inspections.history
	.use(AUTHZ.osRead)
	.handler(async ({ input, context }) => {
		const workspace = await requireWorkspace(context, input.workspaceId);
		const rows = await listOsWorkspaceInspections(queryDb(context), {
			organizationId: workspace.organizationId,
			workspaceId: workspace.id,
		});
		return {
			items: rows.map((row) => ({
				id: row.id,
				at: row.at.toISOString(),
				inspectorName: row.inspectorName,
			})),
		};
	});

export const osWorkspaceInspectionProcedures = { workspaces, start, history };
