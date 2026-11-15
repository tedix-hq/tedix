import { getOsWorkspace } from "./os-workspaces/workspaces";
import { and, eq } from "drizzle-orm";
import { tedis } from "../schema/tedis";
import type { DbQueryClient } from "../query-client";
import type { OsWorkspaceRow } from "../schema/os-workspaces";
import {
	getOsWorkspaceForCollaboration,
	loadOsWorkspacePermissionRows,
	listOsWorkspaceOrganizationMemberRoles,
	type OsWorkspacePermissionRows,
} from "./os-collaborators";
import { getMemberAccessByUserId } from "./organization-members";
import {
	computeEffectiveRoles,
	type PermissionGraph,
	type GraphEdge,
} from "@tedix/api-contract/utils/os-collaborator-graph";
import type { OsCollaboratorRole } from "@tedix/api-contract/schemas/os-collaborators";

const ORG_ROLE: Record<string, OsCollaboratorRole> = {
	owner: "build",
	admin: "build",
	member: "build",
	viewer: "use",
};

function toGraphEdges(rows: OsWorkspacePermissionRows): GraphEdge[] {
	return rows.edges.flatMap((edge): GraphEdge[] => {
		if (edge.kind === "user" && edge.sharerUserId && edge.role)
			return [
				{
					kind: "user",
					targetId: edge.targetUserId,
					sharerId: edge.sharerUserId,
					role: edge.role,
				},
			];
		if (edge.kind === "link" && edge.linkId)
			return [
				{ kind: "link", targetId: edge.targetUserId, linkId: edge.linkId },
			];
		return [];
	});
}

/**
 * Roots hold `build` implicitly. A private workspace has one: its owner. An
 * organization workspace is already open to its organization's members, so
 * members who appear in the graph (as sharers, link creators or the caller)
 * are roots at their organization role. Administrators are the private
 * owner, or the organization's owners and admins.
 */
async function loadRoots(
	database: DbQueryClient,
	workspace: OsWorkspaceRow,
	rows: OsWorkspacePermissionRows,
	callerId: string,
): Promise<{
	roots: Map<string, OsCollaboratorRole>;
	administrators: Set<string>;
}> {
	if (workspace.visibility === "private") {
		const owner = workspace.ownerUserId;
		return {
			roots: new Map(owner ? [[owner, "build"] as const] : []),
			administrators: new Set(owner ? [owner] : []),
		};
	}
	const candidates = new Set<string>([callerId]);
	for (const edge of rows.edges) {
		candidates.add(edge.targetUserId);
		if (edge.sharerUserId) candidates.add(edge.sharerUserId);
	}
	for (const link of rows.links) candidates.add(link.creatorUserId);
	const members = await listOsWorkspaceOrganizationMemberRoles(database, {
		organizationId: workspace.organizationId,
		userIds: [...candidates],
	});
	return {
		roots: new Map(
			members.flatMap((member) => {
				const role = ORG_ROLE[member.role];
				return role ? [[member.userId, role] as const] : [];
			}),
		),
		administrators: new Set(
			members
				.filter((member) => member.role === "owner" || member.role === "admin")
				.map((member) => member.userId),
		),
	};
}

export async function loadWorkspaceAccess(
	database: DbQueryClient,
	workspace: OsWorkspaceRow,
	callerId: string,
) {
	const rows = await loadOsWorkspacePermissionRows(database, {
		organizationId: workspace.organizationId,
		workspaceId: workspace.id,
	});
	const { roots, administrators } = await loadRoots(
		database,
		workspace,
		rows,
		callerId,
	);
	const graph: PermissionGraph = {
		roots,
		edges: toGraphEdges(rows),
		links: rows.links.map((link) => ({
			id: link.id,
			creatorId: link.creatorUserId,
			role: link.role,
			revoked: link.revokedAt !== null,
		})),
	};
	const roles = computeEffectiveRoles(graph);
	return {
		workspace,
		callerId,
		rows,
		graph,
		roles,
		role: roles.get(callerId) ?? null,
		isRoot: roots.has(callerId),
		canAdminister: administrators.has(callerId),
	};
}

/** Revalidate a previously verified socket identity without storing its credentials. */
export async function readWorkspaceSessionRole(
	database: DbQueryClient,
	workspaceId: string,
	userId: string,
): Promise<OsCollaboratorRole | null> {
	const workspace = await getOsWorkspaceForCollaboration(database, {
		workspaceId,
	});
	if (!workspace || workspace.status !== "active") return null;
	const member = await getMemberAccessByUserId(
		database,
		workspace.organizationId,
		userId,
	);
	// Explicit shares cannot keep a suspended organization seat connected.
	if (member && member.status !== "active") return null;
	return (await loadWorkspaceAccess(database, workspace, userId)).role;
}

/** Current role for a principal authenticated by a trusted workspace ingress.
 * A tedi can use its personal owner's grant only while that binding is active.
 * Organization/app/service identity alone is never a workspace grant.
 */
export async function readWorkspaceRuntimeRole(
	database: DbQueryClient,
	scope: { organizationId: string; workspaceId: string },
	principal: { actorId: string; actorKind: string },
): Promise<OsCollaboratorRole | null> {
	const workspace = await getOsWorkspace(database, scope);
	if (!workspace || workspace.status !== "active") return null;
	let userId = principal.actorId;
	if (principal.actorKind === "tedi") {
		const tedi = await readWorkspaceTedi(
			database,
			scope.organizationId,
			principal.actorId,
		);
		if (
			!tedi ||
			tedi.status !== "active" ||
			tedi.scope !== "personal" ||
			!tedi.ownerUserId
		)
			return null;
		userId = tedi.ownerUserId;
	} else if (principal.actorKind !== "user") return null;
	return readWorkspaceSessionRole(database, workspace.id, userId);
}

async function readWorkspaceTedi(
	database: DbQueryClient,
	organizationId: string,
	tediId: string,
) {
	const [tedi] = await database
		.select({
			status: tedis.status,
			scope: tedis.scope,
			ownerUserId: tedis.ownerUserId,
		})
		.from(tedis)
		.where(and(eq(tedis.id, tediId), eq(tedis.organizationId, organizationId)))
		.limit(1);
	return tedi;
}

/** Selecting a guest cannot impersonate another person's personal tedi. */
export async function isWorkspaceGuestTediAllowed(
	database: DbQueryClient,
	organizationId: string,
	principal: { actorId: string; actorKind: string },
	tediId: string,
): Promise<boolean> {
	const tedi = await readWorkspaceTedi(database, organizationId, tediId);
	if (!tedi || tedi.status !== "active") return false;
	if (principal.actorKind === "tedi") return principal.actorId === tediId;
	return (
		principal.actorKind === "user" &&
		(tedi.scope === "organization" || tedi.ownerUserId === principal.actorId)
	);
}
