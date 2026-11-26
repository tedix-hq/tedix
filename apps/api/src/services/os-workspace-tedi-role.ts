import { coreQueryDb } from "@tedix/db/core-store/scope";
import {
	grantOsWorkspaceAccess,
	loadOsWorkspacePermissionRows,
} from "@tedix/db/queries/os-collaborators";
import { readWorkspaceRuntimeRole } from "@tedix/db/queries/os-workspace-access";
import { listOsWorkspaceIdsLinkingSkill } from "@tedix/db/queries/os-workspaces/resources";
import { getOsWorkspace } from "@tedix/db/queries/os-workspaces/workspaces";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";

import { resolveOsWorkspacePrincipal } from "./os-workspace-visibility";
import type { BaseContext } from "../rpc/orpc";

type ExecutorRoleParams = {
	organizationId: string;
	workspaceId: string;
	tediId: string;
	note: string;
};

/** Share with an executor through the current builder's graph edge. */
export async function ensureWorkspaceTediRole(
	context: BaseContext,
	params: ExecutorRoleParams,
): Promise<boolean> {
	const principal = await resolveOsWorkspacePrincipal(context);
	if (!principal || context.organizationId !== params.organizationId)
		return false;
	return grantExecutorRole(context, params, principal);
}

/** Called only after skill-move authorization, before handing its schedule to the new executor. */
export async function transferWorkspaceSkillTediRoles(
	context: BaseContext,
	params: {
		organizationId: string;
		skillId: string;
		fromTediId: string | null;
		toTediId: string;
	},
) {
	for (const workspaceId of await listOsWorkspaceIdsLinkingSkill(
		context.db,
		params,
	)) {
		const input = {
			organizationId: params.organizationId,
			workspaceId,
			tediId: params.toTediId,
			note: "Linked skill ownership transfer",
		};
		if (params.fromTediId)
			await grantExecutorRole(context, input, {
				actorKind: "tedi",
				actorId: params.fromTediId,
			});
		else await ensureWorkspaceTediRole(context, input);
	}
}

async function grantExecutorRole(
	context: BaseContext,
	params: ExecutorRoleParams,
	principal: { actorKind: "user" | "tedi"; actorId: string },
): Promise<boolean> {
	let sharerUserId = principal.actorId;
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
	if (
		!workspace ||
		workspace.status !== "active" ||
		!tedi ||
		tedi.status !== "active"
	)
		return false;
	const { edges, collaborators } = await loadOsWorkspacePermissionRows(
		db,
		scope,
	);
	// A removed collaborator stays recorded; automatic linking must not restore its access.
	if (
		collaborators.some((row) => row.userId === tedi.id) ||
		edges.some((edge) => edge.targetUserId === tedi.id)
	)
		return false;
	if ((await readWorkspaceRuntimeRole(db, scope, principal)) !== "build")
		return false;
	if (
		principal.actorKind === "tedi" &&
		!edges.some((edge) => edge.targetUserId === principal.actorId)
	) {
		const source = await getTediByIdForOrganization(
			context.db,
			principal.actorId,
			params.organizationId,
		);
		// An inherited personal role depends on the owner's grant, not an absent tedi edge.
		if (source?.scope === "personal" && source.ownerUserId)
			sharerUserId = source.ownerUserId;
	}
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
}
