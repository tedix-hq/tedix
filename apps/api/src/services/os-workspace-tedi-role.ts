import {
	findOsWorkspaceOrganizationSharer,
	grantOsWorkspaceAccess,
	loadOsWorkspacePermissionRows,
} from "@tedix/db/queries/os-collaborators";
import { readWorkspaceRuntimeRole } from "@tedix/db/queries/os-workspace-access";
import { getOsWorkspace } from "@tedix/db/queries/os-workspaces/workspaces";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import { createDbQueryClient } from "@tedix/db/query-client";
import { safeExceptionTopology } from "../lib/safe-log-metadata";
import type { BaseContext } from "../rpc/orpc";

/**
 * Record a tedi's own `build` role in a workspace it was just set to work in
 * (a linked skill, a factory lane, an applied blueprint, an app run, a
 * calendar configuration). Call it only after the flow itself was allowed.
 *
 * The role is an ordinary grant edge, so it needs a person who holds `build`
 * as its sharer: the signed-in caller; otherwise a personal tedi's owner;
 * otherwise the workspace's own root (a private workspace's owner, or the
 * organization's first owner, admin or member). A tedi that already has an
 * edge keeps it. Recording is best effort and never fails the flow: a tedi
 * without a role is still judged by the older rules.
 */
export async function ensureWorkspaceTediRole(
	context: BaseContext,
	params: {
		organizationId: string;
		workspaceId: string;
		tediId: string;
		note: string;
	},
): Promise<boolean> {
	try {
		const scope = {
			organizationId: params.organizationId,
			workspaceId: params.workspaceId,
		};
		const db = createDbQueryClient(context.env.DB);
		const [workspace, tedi] = await Promise.all([
			getOsWorkspace(db, scope),
			getTediByIdForOrganization(
				context.db,
				params.tediId,
				params.organizationId,
			),
		]);
		if (!workspace || workspace.status !== "active" || !tedi) return false;
		const { edges } = await loadOsWorkspacePermissionRows(db, {
			...scope,
			collaborators: false,
		});
		if (edges.some((edge) => edge.targetUserId === tedi.id)) return false;
		const sharerUserId =
			context.authType === "user"
				? context.user?.sub
				: tedi.scope === "personal" && tedi.ownerUserId
					? tedi.ownerUserId
					: workspace.visibility === "private"
						? workspace.ownerUserId
						: await findOsWorkspaceOrganizationSharer(
								db,
								params.organizationId,
							);
		if (
			!sharerUserId ||
			(await readWorkspaceRuntimeRole(db, scope, {
				actorKind: "user",
				actorId: sharerUserId,
			})) !== "build"
		)
			return false;
		await grantOsWorkspaceAccess(db, {
			...scope,
			now: new Date().toISOString(),
			edges: [
				{
					kind: "tedi",
					targetUserId: tedi.id,
					targetEmail: null,
					targetName: tedi.displayName ?? tedi.name,
					sharerUserId,
					role: "build",
					note: params.note,
				},
			],
		});
		return true;
	} catch (error) {
		console.warn("os_workspace_tedi_role_not_recorded", {
			workspaceId: params.workspaceId,
			tediId: params.tediId,
			exception: safeExceptionTopology(error),
		});
		return false;
	}
}
