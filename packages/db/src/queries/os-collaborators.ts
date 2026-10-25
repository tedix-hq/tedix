import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { DbQueryClient } from "../query-client";
import { organizationMembers } from "../schema/organization-members";
import {
	type OsWorkspaceAccessEdgeRow,
	type OsWorkspaceCollaboratorRow,
	type OsWorkspaceShareLinkRow,
	osWorkspaceAccessEdges,
	osWorkspaceCollaborators,
	osWorkspaceShareKeys,
	osWorkspaceShareLinks,
} from "../schema/os-collaborators";
import { type OsWorkspaceRow, osWorkspaces } from "../schema/os-workspaces";
import { chunkForBoundParams } from "../utils/batch";

type Batch = [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]];

export type OsCollaboratorRole = "use" | "build";

export interface OsWorkspaceGraphScopeParams {
	organizationId: string;
	workspaceId: string;
}

/**
 * A workspace by id across organizations. Collaborators may belong to another
 * organization, so the caller authorizes through the permission graph of the
 * returned row, never through its own tenant.
 */
export async function getOsWorkspaceForCollaboration(
	db: DbQueryClient,
	params: { workspaceId: string },
): Promise<OsWorkspaceRow | undefined> {
	const [row] = await db
		.select()
		.from(osWorkspaces)
		.where(eq(osWorkspaces.id, params.workspaceId))
		.limit(1);
	return row;
}

export interface OsWorkspacePermissionRows {
	collaborators: OsWorkspaceCollaboratorRow[];
	edges: OsWorkspaceAccessEdgeRow[];
	links: OsWorkspaceShareLinkRow[];
}

/** Every row the permission graph of one workspace is computed from. */
export async function loadOsWorkspacePermissionRows(
	db: DbQueryClient,
	params: OsWorkspaceGraphScopeParams,
): Promise<OsWorkspacePermissionRows> {
	const [collaborators, edges, links] = await db.batch([
		db
			.select()
			.from(osWorkspaceCollaborators)
			.where(
				and(
					eq(osWorkspaceCollaborators.organizationId, params.organizationId),
					eq(osWorkspaceCollaborators.workspaceId, params.workspaceId),
				),
			),
		db
			.select()
			.from(osWorkspaceAccessEdges)
			.where(
				and(
					eq(osWorkspaceAccessEdges.organizationId, params.organizationId),
					eq(osWorkspaceAccessEdges.workspaceId, params.workspaceId),
				),
			),
		db
			.select()
			.from(osWorkspaceShareLinks)
			.where(
				and(
					eq(osWorkspaceShareLinks.organizationId, params.organizationId),
					eq(osWorkspaceShareLinks.workspaceId, params.workspaceId),
				),
			)
			.orderBy(desc(osWorkspaceShareLinks.createdAt)),
	]);
	return { collaborators, edges, links };
}

export interface TedixPersonResult {
	userId: string;
	email: string;
	name: string | null;
}

/** An existing Tedix person by email, from any organization they belong to. */
export async function findTedixPersonByEmail(
	db: DbQueryClient,
	email: string,
): Promise<TedixPersonResult | undefined> {
	const [row] = await db
		.select({
			userId: organizationMembers.descopeUserId,
			email: organizationMembers.email,
			name: organizationMembers.name,
		})
		.from(organizationMembers)
		.where(
			and(
				sql`lower(${organizationMembers.email}) = ${email.trim().toLowerCase()}`,
				eq(organizationMembers.status, "active"),
				eq(organizationMembers.kind, "human"),
			),
		)
		.limit(1);
	return row;
}

/** Display names for people, read from any membership they hold. */
export async function listTedixPeople(
	db: DbQueryClient,
	userIds: readonly string[],
): Promise<TedixPersonResult[]> {
	const rows: TedixPersonResult[] = [];
	for (const ids of chunkForBoundParams([...new Set(userIds)], 50)) {
		rows.push(
			...(await db
				.select({
					userId: organizationMembers.descopeUserId,
					email: organizationMembers.email,
					name: organizationMembers.name,
				})
				.from(organizationMembers)
				.where(inArray(organizationMembers.descopeUserId, ids))),
		);
	}
	const seen = new Map<string, TedixPersonResult>();
	for (const row of rows) if (!seen.has(row.userId)) seen.set(row.userId, row);
	return [...seen.values()];
}

export interface OrganizationMemberRoleResult {
	userId: string;
	role: "owner" | "admin" | "member" | "viewer";
}

/** Active human members of the workspace's organization among `userIds`. */
export async function listOsWorkspaceOrganizationMemberRoles(
	db: DbQueryClient,
	params: { organizationId: string; userIds: readonly string[] },
): Promise<OrganizationMemberRoleResult[]> {
	const rows: OrganizationMemberRoleResult[] = [];
	for (const ids of chunkForBoundParams([...new Set(params.userIds)], 50)) {
		rows.push(
			...(await db
				.select({
					userId: organizationMembers.descopeUserId,
					role: organizationMembers.role,
				})
				.from(organizationMembers)
				.where(
					and(
						eq(organizationMembers.organizationId, params.organizationId),
						inArray(organizationMembers.descopeUserId, ids),
						eq(organizationMembers.status, "active"),
						eq(organizationMembers.kind, "human"),
					),
				)),
		);
	}
	return rows;
}

export interface OsWorkspaceEdgeInput {
	targetUserId: string;
	targetEmail: string | null;
	targetName: string | null;
	kind: "user" | "link";
	sharerUserId?: string;
	linkId?: string;
	role?: OsCollaboratorRole;
	note?: string | null;
}

function edgeKey(edge: OsWorkspaceEdgeInput): string {
	return edge.kind === "user"
		? `user:${edge.sharerUserId}`
		: `link:${edge.linkId}`;
}

function grantStatements(
	db: DbQueryClient,
	scope: OsWorkspaceGraphScopeParams,
	edge: OsWorkspaceEdgeInput,
	now: string,
): BatchItem<"sqlite">[] {
	return [
		db
			.insert(osWorkspaceCollaborators)
			.values({
				id: crypto.randomUUID(),
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				userId: edge.targetUserId,
				email: edge.targetEmail,
				name: edge.targetName,
				createdAt: now,
			})
			.onConflictDoUpdate({
				target: [
					osWorkspaceCollaborators.workspaceId,
					osWorkspaceCollaborators.userId,
				],
				set: {
					email: sql`coalesce(excluded.email, ${osWorkspaceCollaborators.email})`,
					name: sql`coalesce(excluded.name, ${osWorkspaceCollaborators.name})`,
				},
			}),
		db
			.insert(osWorkspaceAccessEdges)
			.values({
				id: crypto.randomUUID(),
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				targetUserId: edge.targetUserId,
				kind: edge.kind,
				edgeKey: edgeKey(edge),
				sharerUserId: edge.kind === "user" ? edge.sharerUserId : null,
				linkId: edge.kind === "link" ? edge.linkId : null,
				role: edge.kind === "user" ? edge.role : null,
				note: edge.note ?? null,
				createdAt: now,
			})
			.onConflictDoUpdate({
				target: [
					osWorkspaceAccessEdges.workspaceId,
					osWorkspaceAccessEdges.targetUserId,
					osWorkspaceAccessEdges.edgeKey,
				],
				set: { role: sql`excluded.role` },
			}),
	];
}

/** Write grant edges (and their collaborator rows) in one batch. */
export async function grantOsWorkspaceAccess(
	db: DbQueryClient,
	params: OsWorkspaceGraphScopeParams & {
		edges: OsWorkspaceEdgeInput[];
		now: string;
	},
): Promise<void> {
	const statements = params.edges.flatMap((edge) =>
		grantStatements(db, params, edge, params.now),
	);
	if (statements.length === 0) return;
	await db.batch(statements as Batch);
}

/**
 * Lazy revocation: sever only the edges that grant the target access, then
 * write any re-rooting edges, all in one batch. `sharerUserId` limits the
 * severance to that sharer's own edge; without it every incoming edge goes.
 * Collaborator rows and the target's outgoing grants are kept.
 */
export async function severOsWorkspaceUserAccess(
	db: DbQueryClient,
	params: OsWorkspaceGraphScopeParams & {
		targetUserId: string;
		sharerUserId?: string;
		keepEdges: OsWorkspaceEdgeInput[];
		now: string;
	},
): Promise<void> {
	const sever = db
		.delete(osWorkspaceAccessEdges)
		.where(
			and(
				eq(osWorkspaceAccessEdges.organizationId, params.organizationId),
				eq(osWorkspaceAccessEdges.workspaceId, params.workspaceId),
				eq(osWorkspaceAccessEdges.targetUserId, params.targetUserId),
				params.sharerUserId
					? eq(osWorkspaceAccessEdges.edgeKey, `user:${params.sharerUserId}`)
					: undefined,
			),
		);
	await db.batch([
		sever,
		...params.keepEdges.flatMap((edge) =>
			grantStatements(db, params, edge, params.now),
		),
	] as Batch);
}

/**
 * Revoke a link by flag (edges keep pointing at it), delete its keys so none
 * redeems, and write re-rooting edges, in one batch.
 */
export async function revokeOsWorkspaceShareLink(
	db: DbQueryClient,
	params: OsWorkspaceGraphScopeParams & {
		linkId: string;
		keepEdges: OsWorkspaceEdgeInput[];
		now: string;
	},
): Promise<void> {
	const scoped = and(
		eq(osWorkspaceShareLinks.organizationId, params.organizationId),
		eq(osWorkspaceShareLinks.workspaceId, params.workspaceId),
		eq(osWorkspaceShareLinks.id, params.linkId),
	);
	await db.batch([
		db
			.update(osWorkspaceShareLinks)
			.set({
				revokedAt: sql`coalesce(${osWorkspaceShareLinks.revokedAt}, ${params.now})`,
			})
			.where(scoped),
		db
			.delete(osWorkspaceShareKeys)
			.where(
				and(
					eq(osWorkspaceShareKeys.linkId, params.linkId),
					sql`exists (select 1 from ${osWorkspaceShareLinks} where ${scoped})`,
				),
			),
		...params.keepEdges.flatMap((edge) =>
			grantStatements(db, params, edge, params.now),
		),
	] as Batch);
}

export async function createOsWorkspaceShareLink(
	db: DbQueryClient,
	params: OsWorkspaceGraphScopeParams & {
		id: string;
		creatorUserId: string;
		role: OsCollaboratorRole;
		label: string | null;
		keyHash: string;
		now: string;
	},
): Promise<OsWorkspaceShareLinkRow> {
	const [links] = await db.batch([
		db
			.insert(osWorkspaceShareLinks)
			.values({
				id: params.id,
				organizationId: params.organizationId,
				workspaceId: params.workspaceId,
				creatorUserId: params.creatorUserId,
				role: params.role,
				label: params.label,
				createdAt: params.now,
			})
			.returning(),
		db.insert(osWorkspaceShareKeys).values({
			keyHash: params.keyHash,
			linkId: params.id,
			createdAt: params.now,
		}),
	]);
	const link = links[0];
	if (!link) throw new Error("Share link insert returned no row");
	return link;
}

/** Mint another key for an active link; returns false when it is revoked. */
export async function addOsWorkspaceShareKey(
	db: DbQueryClient,
	params: OsWorkspaceGraphScopeParams & {
		linkId: string;
		keyHash: string;
		now: string;
	},
): Promise<boolean> {
	const result = await db
		.insert(osWorkspaceShareKeys)
		.select(
			db
				.select({
					keyHash: sql<string>`${params.keyHash}`.as("key_hash"),
					linkId: osWorkspaceShareLinks.id,
					createdAt: sql<string>`${params.now}`.as("created_at"),
				})
				.from(osWorkspaceShareLinks)
				.where(
					and(
						eq(osWorkspaceShareLinks.organizationId, params.organizationId),
						eq(osWorkspaceShareLinks.workspaceId, params.workspaceId),
						eq(osWorkspaceShareLinks.id, params.linkId),
						isNull(osWorkspaceShareLinks.revokedAt),
					),
				),
		)
		.returning({ keyHash: osWorkspaceShareKeys.keyHash });
	return result.length > 0;
}

/** The active link a key belongs to, if the key is known and not revoked. */
export async function getActiveOsWorkspaceShareLinkByKeyHash(
	db: DbQueryClient,
	params: { workspaceId: string; keyHash: string },
): Promise<OsWorkspaceShareLinkRow | undefined> {
	const [row] = await db
		.select({ link: osWorkspaceShareLinks })
		.from(osWorkspaceShareKeys)
		.innerJoin(
			osWorkspaceShareLinks,
			eq(osWorkspaceShareLinks.id, osWorkspaceShareKeys.linkId),
		)
		.where(
			and(
				eq(osWorkspaceShareKeys.keyHash, params.keyHash),
				eq(osWorkspaceShareLinks.workspaceId, params.workspaceId),
				isNull(osWorkspaceShareLinks.revokedAt),
			),
		)
		.limit(1);
	return row?.link;
}

/** Stamp an open so the workspace lists for the collaborator, with cached labels. */
export async function recordOsWorkspaceCollaboratorOpen(
	db: DbQueryClient,
	params: OsWorkspaceGraphScopeParams & {
		userId: string;
		title: string;
		ownerName: string | null;
		now: string;
	},
): Promise<void> {
	await db
		.update(osWorkspaceCollaborators)
		.set({
			firstOpenedAt: sql`coalesce(${osWorkspaceCollaborators.firstOpenedAt}, ${params.now})`,
			lastOpenedAt: params.now,
			cachedTitle: params.title,
			cachedOwnerName: params.ownerName,
			dismissedAt: null,
		})
		.where(
			and(
				eq(osWorkspaceCollaborators.organizationId, params.organizationId),
				eq(osWorkspaceCollaborators.workspaceId, params.workspaceId),
				eq(osWorkspaceCollaborators.userId, params.userId),
			),
		);
}

/**
 * Workspaces shared with a person that they have opened and not dismissed.
 * Access is not rechecked here; an entry whose access was revoked stays until
 * dismissed, and opening it reports access denied.
 */
export async function listOsSharedWorkspacesForUser(
	db: DbQueryClient,
	params: { userId: string; limit: number },
): Promise<OsWorkspaceCollaboratorRow[]> {
	return db
		.select()
		.from(osWorkspaceCollaborators)
		.where(
			and(
				eq(osWorkspaceCollaborators.userId, params.userId),
				isNotNull(osWorkspaceCollaborators.firstOpenedAt),
				isNull(osWorkspaceCollaborators.dismissedAt),
			),
		)
		.orderBy(desc(osWorkspaceCollaborators.lastOpenedAt))
		.limit(params.limit);
}

export async function dismissOsSharedWorkspace(
	db: DbQueryClient,
	params: { workspaceId: string; userId: string; now: string },
): Promise<void> {
	await db
		.update(osWorkspaceCollaborators)
		.set({ dismissedAt: params.now })
		.where(
			and(
				eq(osWorkspaceCollaborators.workspaceId, params.workspaceId),
				eq(osWorkspaceCollaborators.userId, params.userId),
			),
		);
}
