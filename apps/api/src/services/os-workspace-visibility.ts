import {
	listWorkspaceTediBuildIds,
	readWorkspaceRuntimeRole,
} from "@tedix/db/queries/os-workspace-access";
import {
	getOsWorkspace,
	isOsWorkspaceVisibleTo,
	type OsWorkspaceViewer,
} from "@tedix/db/queries/os-workspaces/workspaces";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";
import type { OsWorkspaceRow } from "@tedix/db/schema/os-workspaces";
import { type BaseContext, createError, ErrorCodes } from "../rpc/orpc";
import { isOsWorkspaceBuildCollaborator } from "./os-workspace-collaborators";
import { inspectedWorkspaceId } from "./os-workspace-inspection";

/** Human calls retain their verified identity; autonomous tedis use the role graph. */
const viewers = new WeakMap<BaseContext, Promise<OsWorkspaceViewer>>();

export function resolveOsWorkspaceViewer(
	context: BaseContext,
): Promise<OsWorkspaceViewer> {
	let viewer = viewers.get(context);
	if (!viewer) {
		viewer = computeViewer(context);
		viewers.set(context, viewer);
	}
	return viewer;
}

/** Acting-user headers count only on the trusted service binding and for its bound tedi. */
export async function resolveOsWorkspacePrincipal(
	context: BaseContext,
): Promise<{ actorKind: "user" | "tedi"; actorId: string } | null> {
	if (context.authType === "user")
		return context.user?.sub
			? { actorKind: "user", actorId: context.user.sub }
			: null;
	if (
		(context.authType !== "service-binding" && context.authType !== "tedi") ||
		!context.tediId ||
		!context.organizationId
	)
		return null;
	const tedi = await getTediByIdForOrganization(
		context.db,
		context.tediId,
		context.organizationId,
	);
	if (!tedi || tedi.status !== "active") return null;
	const actingUser =
		context.authType === "service-binding" ? context.descopeUserId : undefined;
	if (
		actingUser &&
		tedi.ownerUserId !== actingUser &&
		tedi.descopeUserId !== actingUser
	)
		return null;
	if (actingUser && tedi.scope === "organization")
		return { actorKind: "user", actorId: actingUser };
	return { actorKind: "tedi", actorId: tedi.id };
}

async function computeViewer(context: BaseContext): Promise<OsWorkspaceViewer> {
	const principal = await resolveOsWorkspacePrincipal(context);
	if (principal?.actorKind === "tedi")
		return {
			userIds: [],
			onlyWorkspaceIds: await listWorkspaceTediBuildIds(
				context.db,
				context.organizationId!,
				principal.actorId,
			),
		};
	if (context.tediId && !principal)
		return { userIds: [], onlyWorkspaceIds: [] };
	const viewer = { userIds: principal ? [principal.actorId] : [] };
	const inspected = await inspectedWorkspaceId(context);
	return inspected ? { ...viewer, workspaceIds: [inspected] } : viewer;
}

/** The member the caller acts for, when it is exactly one human. */
export async function resolveOsWorkspaceOwnerCandidate(
	context: BaseContext,
): Promise<string | null> {
	const principal = await resolveOsWorkspacePrincipal(context);
	if (principal?.actorKind === "user") return principal.actorId;
	if (principal?.actorKind === "tedi") {
		const tedi = await getTediByIdForOrganization(
			context.db,
			principal.actorId,
			context.organizationId!,
		);
		return tedi?.scope === "personal" ? tedi.ownerUserId : null;
	}
	return null;
}

/**
 * Throw NOT_FOUND (never FORBIDDEN: existence is private too). A `build`
 * collaborator of a private workspace sees it like its owner, except for
 * `ownerOnly` actions (archive, delete, changing who owns it).
 */
export async function assertOsWorkspaceVisible(
	context: BaseContext,
	workspace: Pick<OsWorkspaceRow, "id" | "visibility" | "ownerUserId"> &
		Partial<OsWorkspaceRow>,
	message = "OS workspace not found",
	options: { ownerOnly?: boolean } = {},
): Promise<void> {
	if (
		(context.authType === "tedi" || context.authType === "service-binding") &&
		context.tediId
	) {
		const principal = await resolveOsWorkspacePrincipal(context);
		if (
			!principal ||
			!workspace.organizationId ||
			workspace.organizationId !== context.organizationId
		)
			throw createError(ErrorCodes.NOT_FOUND, message);
		const role = await readWorkspaceRuntimeRole(
			context.db,
			{ organizationId: workspace.organizationId, workspaceId: workspace.id },
			principal,
		);
		const ownerId = options.ownerOnly
			? await resolveOsWorkspaceOwnerCandidate(context)
			: null;
		if (
			role === "build" &&
			(!options.ownerOnly || (ownerId && workspace.ownerUserId === ownerId))
		)
			return;
		throw createError(ErrorCodes.NOT_FOUND, message);
	}
	if (workspace.visibility !== "private") return;
	if (
		isOsWorkspaceVisibleTo(workspace, await resolveOsWorkspaceViewer(context))
	)
		return;
	const callerId = context.authType === "user" ? context.user?.sub : undefined;
	if (
		!options.ownerOnly &&
		callerId &&
		workspace.organizationId &&
		(await isOsWorkspaceBuildCollaborator(
			context,
			workspace as OsWorkspaceRow,
			callerId,
		))
	)
		return;
	throw createError(ErrorCodes.NOT_FOUND, message);
}

/** Visibility of a workspace child (output, gadget) by its workspace id. */
export async function assertOsWorkspaceChildVisible(
	context: BaseContext,
	organizationId: string,
	workspaceId: string | null,
	message: string,
): Promise<void> {
	if (!workspaceId) return;
	const workspace = await getOsWorkspace(context.db, {
		organizationId,
		workspaceId,
	});
	if (workspace) await assertOsWorkspaceVisible(context, workspace, message);
}
