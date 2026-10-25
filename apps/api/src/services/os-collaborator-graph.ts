/**
 * Workspace permission graph. Pure: no I/O, so every access decision (open,
 * listing, removal previews) derives from one computation over the same rows.
 *
 * Nodes are people. Roots (the workspace owner) hold `build` implicitly and
 * are never stored as collaborators. Each collaborator has one or more edges
 * explaining how they got access:
 * - a user edge: a sharer added them directly at a role;
 * - a link edge: they redeemed a key for a share link; the role comes from
 *   the link, and the link's creator is the sharer.
 *
 * An edge grants min(edge role, sharer's effective role). A collaborator's
 * effective role is the max over their edges. Roles only rise during the
 * iteration, so it reaches a fixed point; cycles and diamonds need no special
 * handling. Nobody stores an effective role: it is recomputed from edges.
 */
import {
	collaboratorRoleAtLeast,
	minCollaboratorRole,
	OS_COLLABORATOR_ROLE_RANK,
	type OsCollaboratorRole,
} from "@tedix/api-contract/schemas/os-collaborators";

export type GraphUserEdge = {
	kind: "user";
	targetId: string;
	sharerId: string;
	role: OsCollaboratorRole;
};
export type GraphLinkEdge = { kind: "link"; targetId: string; linkId: string };
export type GraphEdge = GraphUserEdge | GraphLinkEdge;

export type GraphLink = {
	id: string;
	creatorId: string;
	role: OsCollaboratorRole;
	revoked: boolean;
};

export type PermissionGraph = {
	/** Implicit roots, usually just the owner at `build`. */
	roots: ReadonlyMap<string, OsCollaboratorRole>;
	edges: readonly GraphEdge[];
	links: readonly GraphLink[];
};

/** A change to model without writing it. */
export type GraphChange = {
	removedUserId?: string;
	removedEdge?: { targetId: string; sharerId: string };
	revokedLinkId?: string;
};

export type RoleMap = Map<string, OsCollaboratorRole>;

function maxRole(
	a: OsCollaboratorRole | undefined,
	b: OsCollaboratorRole,
): OsCollaboratorRole {
	if (!a) return b;
	return OS_COLLABORATOR_ROLE_RANK[a] >= OS_COLLABORATOR_ROLE_RANK[b] ? a : b;
}

/**
 * Effective role of everyone reachable from a root. Absence means no access.
 * Roots appear in the map with their root role.
 */
export function computeEffectiveRoles(
	graph: PermissionGraph,
	change: GraphChange = {},
): RoleMap {
	const roles: RoleMap = new Map(graph.roots);
	const links = new Map<string, GraphLink>();
	for (const link of graph.links) {
		if (link.revoked || link.id === change.revokedLinkId) continue;
		links.set(link.id, link);
	}
	const edges = graph.edges.filter((edge) => {
		if (graph.roots.has(edge.targetId)) return false;
		if (edge.targetId === change.removedUserId) return false;
		if (
			edge.kind === "user" &&
			change.removedEdge &&
			edge.targetId === change.removedEdge.targetId &&
			edge.sharerId === change.removedEdge.sharerId
		)
			return false;
		return true;
	});
	let changed = true;
	while (changed) {
		changed = false;
		for (const edge of edges) {
			const granted = grantedRole(edge, roles, links, change);
			if (!granted) continue;
			const current = roles.get(edge.targetId);
			const next = maxRole(current, granted);
			if (next !== current) {
				roles.set(edge.targetId, next);
				changed = true;
			}
		}
	}
	return roles;
}

function grantedRole(
	edge: GraphEdge,
	roles: RoleMap,
	links: Map<string, GraphLink>,
	change: GraphChange,
): OsCollaboratorRole | null {
	let sharerId: string;
	let edgeRole: OsCollaboratorRole;
	if (edge.kind === "user") {
		sharerId = edge.sharerId;
		edgeRole = edge.role;
	} else {
		const link = links.get(edge.linkId);
		if (!link) return null;
		sharerId = link.creatorId;
		edgeRole = link.role;
	}
	if (sharerId === change.removedUserId) return null;
	const sharerRole = roles.get(sharerId);
	if (!sharerRole) return null;
	return minCollaboratorRole(edgeRole, sharerRole);
}

export type RoleChange = {
	userId: string;
	oldRole: OsCollaboratorRole;
	newRole: OsCollaboratorRole | null;
};

/** People whose access fell between two role maps (removed or downgraded). */
export function diffRoles(before: RoleMap, after: RoleMap): RoleChange[] {
	const changes: RoleChange[] = [];
	for (const [userId, oldRole] of before) {
		const newRole = after.get(userId) ?? null;
		if (
			newRole === null ||
			OS_COLLABORATOR_ROLE_RANK[newRole] < OS_COLLABORATOR_ROLE_RANK[oldRole]
		) {
			changes.push({ userId, oldRole, newRole });
		}
	}
	return changes.sort((a, b) => a.userId.localeCompare(b.userId));
}

/**
 * Fresh user edges from the caller that keep the listed people at their prior
 * role after a removal, bounded by what the caller can grant. Applying them
 * is plain re-adding; this only decides which edges to write.
 */
export function planKeptUserEdges(input: {
	callerId: string;
	callerRole: OsCollaboratorRole;
	affected: readonly RoleChange[];
	keepUserIds: readonly string[];
}): GraphUserEdge[] {
	const keep = new Set(input.keepUserIds);
	return input.affected
		.filter((change) => keep.has(change.userId))
		.filter((change) => change.userId !== input.callerId)
		.map((change) => ({
			kind: "user" as const,
			targetId: change.userId,
			sharerId: input.callerId,
			role: minCollaboratorRole(change.oldRole, input.callerRole),
		}))
		.filter(
			(edge) =>
				!collaboratorRoleAtLeast(
					input.affected.find((c) => c.userId === edge.targetId)?.newRole,
					edge.role,
				),
		);
}
