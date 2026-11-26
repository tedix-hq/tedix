import { getOsWorkspace } from "./os-workspaces/workspaces";
import { and, eq } from "drizzle-orm";
import { tedis } from "../schema/tedis";
import type { DbQueryClient } from "../query-client";
import {
	osWorkspaces as d1OsWorkspaces,
	type OsWorkspaceRow,
} from "../schema/os-workspaces";
import {
	osWorkspaceAccessEdges as d1Edges,
	osWorkspaceShareLinks as d1Links,
} from "../schema/os-collaborators";
import { coreTable } from "../core-store/client";
import { anyIds } from "../core-store/dialect";
import {
	getOsWorkspaceForCollaboration,
	loadOsWorkspacePermissionRows,
	listOsWorkspaceOrganizationMemberRoles,
	type OsWorkspacePermissionRows,
} from "./os-collaborators";
import { getMemberAccessByUserId } from "./organization-members";
import { readAuthContextCacheVersion } from "./auth-context-cache";
import {
	computeEffectiveRoles,
	type PermissionGraph,
	type GraphEdge,
} from "@tedix/api-contract/utils/os-collaborator-graph";
import type { OsCollaboratorRole } from "@tedix/api-contract/schemas/os-collaborators";

type WorkspaceAccess = {
	workspace: OsWorkspaceRow;
	callerId: string;
	rows: OsWorkspacePermissionRows;
	graph: PermissionGraph;
	roles: Map<string, OsCollaboratorRole>;
	role: OsCollaboratorRole | null;
	isRoot: boolean;
	canAdminister: boolean;
};

const ORG_ROLE: Record<string, OsCollaboratorRole> = {
	owner: "build",
	admin: "build",
	member: "build",
	viewer: "use",
};

/** Fresh roles and names for Home, without per-workspace role caches. */
export function readWorkspaceUserAccessMany(
	database: DbQueryClient,
	organizationId: string,
	userId: string,
	workspaceIds: readonly string[],
) {
	return readWorkspaceAccessMany(
		database,
		organizationId,
		userId,
		workspaceIds,
	);
}

/** Filter before list pagination, using the same graph as direct tedi access. */
export async function listWorkspaceTediBuildIds(
	database: DbQueryClient,
	organizationId: string,
	tediId: string,
): Promise<string[]> {
	const access = await readWorkspaceAccessMany(
		database,
		organizationId,
		tediId,
		undefined,
		"tedi",
	);
	return [...access].flatMap(([id, row]) => (row.role === "build" ? [id] : []));
}

async function readWorkspaceAccessMany(
	database: DbQueryClient,
	organizationId: string,
	userId: string,
	workspaceIds?: readonly string[],
	actorKind: "user" | "tedi" = "user",
): Promise<Map<string, { name: string; role: OsCollaboratorRole | null }>> {
	const result = new Map<
		string,
		{ name: string; role: OsCollaboratorRole | null }
	>();
	if (workspaceIds?.length === 0) return result;
	const tedi =
		actorKind === "tedi"
			? await readWorkspaceTedi(database, organizationId, userId)
			: undefined;
	if (actorKind === "tedi" && (!tedi || tedi.status !== "active"))
		return result;
	const workspaces = coreTable(database, d1OsWorkspaces);
	const edges = coreTable(database, d1Edges);
	const links = coreTable(database, d1Links);
	const [workspaceRows, edgeRows, linkRows] = await database.batch([
		database
			.select()
			.from(workspaces)
			.where(
				and(
					eq(workspaces.organizationId, organizationId),
					workspaceIds
						? anyIds(database, workspaces.id, workspaceIds)
						: undefined,
				),
			),
		database
			.select()
			.from(edges)
			.where(
				and(
					eq(edges.organizationId, organizationId),
					workspaceIds
						? anyIds(database, edges.workspaceId, workspaceIds)
						: undefined,
				),
			),
		database
			.select()
			.from(links)
			.where(
				and(
					eq(links.organizationId, organizationId),
					workspaceIds
						? anyIds(database, links.workspaceId, workspaceIds)
						: undefined,
				),
			),
	]);
	const ownerId = tedi?.scope === "personal" ? tedi.ownerUserId : null;
	const memberId = actorKind === "user" ? userId : ownerId;
	const member = memberId
		? await getMemberAccessByUserId(database, organizationId, memberId)
		: undefined;
	if (actorKind === "user" && member && member.status !== "active")
		return result;
	const candidates = new Set([userId, ...(ownerId ? [ownerId] : [])]);
	for (const edge of edgeRows) {
		candidates.add(edge.targetUserId);
		if (edge.sharerUserId) candidates.add(edge.sharerUserId);
	}
	for (const link of linkRows) candidates.add(link.creatorUserId);
	const members = await listOsWorkspaceOrganizationMemberRoles(database, {
		organizationId,
		userIds: [...candidates],
	});
	const orgRoots = new Map(
		members.flatMap((row) =>
			ORG_ROLE[row.role] ? [[row.userId, ORG_ROLE[row.role]!] as const] : [],
		),
	);
	for (const workspace of workspaceRows) {
		if (workspace.status !== "active") continue;
		const rows: OsWorkspacePermissionRows = {
			collaborators: [],
			edges: edgeRows.filter((row) => row.workspaceId === workspace.id),
			links: linkRows.filter((row) => row.workspaceId === workspace.id),
		};
		const roots =
			workspace.visibility === "private"
				? new Map(
						workspace.ownerUserId
							? [[workspace.ownerUserId, "build" as const]]
							: [],
					)
				: new Map(orgRoots);

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
		let roles = computeEffectiveRoles(graph);
		if (
			ownerId &&
			(!member || member.status === "active") &&
			!rows.edges.some((edge) => edge.targetUserId === userId)
		) {
			const role = roles.get(ownerId);
			if (role) {
				roots.set(userId, role);
				roles = computeEffectiveRoles(graph);
			}
		}
		result.set(workspace.id, {
			name: workspace.name,
			role: roles.get(userId) ?? null,
		});
	}
	return result;
}

function toGraphEdges(rows: OsWorkspacePermissionRows): GraphEdge[] {
	return rows.edges.flatMap((edge): GraphEdge[] => {
		if (edge.kind !== "link" && edge.sharerUserId && edge.role)
			return [
				{
					kind: edge.kind,
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
	actorKind: "user" | "tedi" = "user",
	/** Role checks skip the collaborator list; roles never read it. */
	options: { collaborators?: boolean } = {},
): Promise<WorkspaceAccess> {
	const rows = await loadOsWorkspacePermissionRows(database, {
		organizationId: workspace.organizationId,
		workspaceId: workspace.id,
		collaborators: options.collaborators,
	});
	const { roots, administrators } = await loadRoots(
		database,
		workspace,
		rows,
		callerId,
	);
	const tedi =
		actorKind === "tedi"
			? await readWorkspaceTedi(database, workspace.organizationId, callerId)
			: undefined;
	if (actorKind === "tedi") {
		// A direct edge takes precedence even if its grant is no longer reachable.
		if (
			tedi?.status === "active" &&
			tedi.scope === "personal" &&
			tedi.ownerUserId &&
			!rows.edges.some((edge) => edge.targetUserId === callerId)
		) {
			const ownerRole = await loadSessionRole(
				database,
				workspace,
				tedi.ownerUserId,
			);
			if (ownerRole) roots.set(callerId, ownerRole);
		}
	}
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
	if (actorKind === "tedi" && (!tedi || tedi.status !== "active"))
		roles.delete(callerId);
	return {
		workspace,
		callerId,
		rows,
		graph,
		roles,
		role: roles.get(callerId) ?? null,
		isRoot: actorKind === "user" && roots.has(callerId),
		canAdminister: actorKind === "user" && administrators.has(callerId),
	};
}

const ROLE_CACHE_TTL_MS = 15_000;
const ROLE_CACHE_LIMIT = 2_000;
const roleCache = new Map<
	string,
	{ version: string; role: OsCollaboratorRole | null; expiresAt: number }
>();

async function readRoleFence(database: DbQueryClient) {
	try {
		return await readAuthContextCacheVersion(database);
	} catch {
		// Without a readable fence nothing is reused.
		return undefined;
	}
}

/**
 * Workspace objects check every socket on every pushed event, and the collab
 * room rechecks every few seconds. A role is reused for 15 seconds only while
 * `auth_context_cache_state` keeps its version: triggers advance it on any
 * change to members, workspaces, access edges, share links or tedis, so a
 * revoke is seen by the next check.
 */
async function cachedRole(
	database: DbQueryClient,
	key: string,
	load: () => Promise<OsCollaboratorRole | null>,
): Promise<OsCollaboratorRole | null> {
	const version = await readRoleFence(database);
	if (!version) return load();
	const hit = roleCache.get(key);
	if (hit && hit.version === version && hit.expiresAt > Date.now())
		return hit.role;
	const role = await load();
	// A change during the load must never stamp the old role with a new version.
	if ((await readRoleFence(database)) === version) {
		roleCache.delete(key);
		roleCache.set(key, {
			version,
			role,
			expiresAt: Date.now() + ROLE_CACHE_TTL_MS,
		});
		if (roleCache.size > ROLE_CACHE_LIMIT)
			roleCache.delete(roleCache.keys().next().value!);
	}
	return role;
}

async function loadSessionRole(
	database: DbQueryClient,
	workspace: OsWorkspaceRow | undefined,
	userId: string,
): Promise<OsCollaboratorRole | null> {
	if (!workspace || workspace.status !== "active") return null;
	const member = await getMemberAccessByUserId(
		database,
		workspace.organizationId,
		userId,
	);
	// Explicit shares cannot keep a suspended organization seat connected.
	if (member && member.status !== "active") return null;
	return (
		await loadWorkspaceAccess(database, workspace, userId, "user", {
			collaborators: false,
		})
	).role;
}

/** Revalidate a previously verified socket identity without storing its credentials. */
export async function readWorkspaceSessionRole(
	database: DbQueryClient,
	workspaceId: string,
	userId: string,
): Promise<OsCollaboratorRole | null> {
	return cachedRole(
		database,
		JSON.stringify(["session", workspaceId, userId]),
		async () =>
			loadSessionRole(
				database,
				await getOsWorkspaceForCollaboration(database, { workspaceId }),
				userId,
			),
	);
}

/** Current role for a principal authenticated by a trusted workspace ingress.
 * A tedi uses its own edge first, then its active personal owner's grant.
 * Organization membership alone never grants a tedi workspace access.
 */
export async function readWorkspaceRuntimeRole(
	database: DbQueryClient,
	scope: { organizationId: string; workspaceId: string },
	principal: { actorId: string; actorKind: string },
): Promise<OsCollaboratorRole | null> {
	if (principal.actorKind !== "tedi" && principal.actorKind !== "user")
		return null;
	return cachedRole(
		database,
		JSON.stringify([
			"runtime",
			scope.organizationId,
			scope.workspaceId,
			principal.actorKind,
			principal.actorId,
		]),
		async () => {
			const workspace = await getOsWorkspace(database, scope);
			if (!workspace || workspace.status !== "active") return null;
			if (principal.actorKind === "tedi")
				return (
					await loadWorkspaceAccess(
						database,
						workspace,
						principal.actorId,
						"tedi",
						{ collaborators: false },
					)
				).role;
			return loadSessionRole(database, workspace, principal.actorId);
		},
	);
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
