import { coreQueryDb } from "@tedix/db/core-store/scope";
import {
	grantOsWorkspaceAccess,
	loadOsWorkspacePermissionRows,
} from "@tedix/db/queries/os-collaborators";
import { readWorkspaceRuntimeRole } from "@tedix/db/queries/os-workspace-access";
import { getOsWorkspace } from "@tedix/db/queries/os-workspaces/workspaces";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";

import { safeExceptionTopology } from "../lib/safe-log-metadata";
import type { BaseContext } from "../rpc/orpc";

/**
 * Record a tedi's own `build` role in a workspace it was just set to work in
 * (a linked skill, a factory lane, an applied blueprint, an app run, a
 * calendar configuration). Call it only after the flow itself was allowed.
 *
 * The role is an ordinary grant edge shared by the caller, so only a
 * signed-in person who holds `build` in the workspace records one. Any other
 * caller (a tedi, an API key, a service) records nothing: it may not share
 * the workspace in someone else's name. A tedi that already has an edge keeps
 * it. Recording is best effort and never fails the flow: a tedi without a
 * role is still judged by the older rules.
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
	const sharerUserId =
		context.authType === "user" ? context.user?.sub : undefined;
	if (!sharerUserId) {
		console.debug("os_workspace_tedi_role_skipped", {
			workspaceId: params.workspaceId,
			tediId: params.tediId,
			authType: context.authType,
		});
		return false;
	}
	try {
		const scope = {
			organizationId: params.organizationId,
			workspaceId: params.workspaceId,
		};
		const db = coreQueryDb(context.env);
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
		if (
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
