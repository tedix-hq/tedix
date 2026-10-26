/**
 * Workspace collaborators: the gate every collaborator session passes, and
 * the sharing operations around it. Access is the permission graph in
 * `os-collaborator-graph.ts`, recomputed from stored edges on every call.
 */
import {
	collaboratorRoleAtLeast,
	type OsAffectedCollaborator,
	type OsCollaborator,
	type OsCollaboratorLink,
	type OsCollaboratorRole,
	type OsCollaboratorTarget,
	type OsWorkspaceCapability,
	operationAllowed,
	operationsForRole,
	type OsWorkspaceOperation,
} from "@tedix/api-contract/schemas/os-collaborators";
import {
	addOsWorkspaceShareKey,
	createOsWorkspaceShareLink,
	findTedixPersonByEmail,
	getActiveOsWorkspaceShareLinkByKeyHash,
	getOsWorkspaceForCollaboration,
	grantOsWorkspaceAccess,
	listOsWorkspaceOrganizationMemberRoles,
	listTedixPeople,
	loadOsWorkspacePermissionRows,
	type OsWorkspaceEdgeInput,
	type OsWorkspacePermissionRows,
	recordOsWorkspaceCollaboratorOpen,
	revokeOsWorkspaceShareLink,
	severOsWorkspaceUserAccess,
	type TedixPersonResult,
} from "@tedix/db/queries/os-collaborators";
import { getOrganizationProfile } from "@tedix/db/queries/organizations";
import {
	getOsGadget,
	getOsGadgetRevision,
	listOsGadgets,
} from "@tedix/db/queries/os-workspaces/gadgets";
import {
	createDbQueryClient,
	type DbQueryClient,
} from "@tedix/db/query-client";
import type { OsWorkspaceRow } from "@tedix/db/schema/os-workspaces";
import { type BaseContext, createError, ErrorCodes } from "../rpc/orpc";
import { cutWorkspaceAppSessions } from "./os-app-session-revocation";
import {
	computeEffectiveRoles,
	diffRoles,
	type GraphChange,
	type GraphEdge,
	type PermissionGraph,
	planKeptUserEdges,
	type RoleChange,
	type RoleMap,
} from "./os-collaborator-graph";

/** Fixed domain-separation key: the hash proves possession, it is not a secret. */
const SHARE_KEY_HMAC_KEY = "tedix.os.workspace-share-key.v1";

/** A random 128-bit key, base64url (22 characters). Never stored. */
export function generateWorkspaceShareKey(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

let hmacKey: Promise<CryptoKey> | null = null;

export async function hashWorkspaceShareKey(key: string): Promise<string> {
	hmacKey ??= crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(SHARE_KEY_HMAC_KEY),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign(
		"HMAC",
		await hmacKey,
		new TextEncoder().encode(key),
	);
	return [...new Uint8Array(mac)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

const ACCESS_DENIED = "You don't have access to this workspace";

function db(context: BaseContext): DbQueryClient {
	return createDbQueryClient(context.env.DB);
}

/** Collaborators act only as themselves: a signed-in human. */
export function requireCollaboratorIdentity(context: BaseContext): string {
	if (context.authType === "user" && context.user?.sub) return context.user.sub;
	throw createError(
		ErrorCodes.FORBIDDEN,
		"Sharing needs a signed-in Tedix user",
	);
}

type WorkspaceAccess = {
	workspace: OsWorkspaceRow;
	callerId: string;
	rows: OsWorkspacePermissionRows;
	graph: PermissionGraph;
	roles: RoleMap;
	role: OsCollaboratorRole | null;
	isRoot: boolean;
};

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
 * are roots at their organization role.
 */
async function loadRoots(
	database: DbQueryClient,
	workspace: OsWorkspaceRow,
	rows: OsWorkspacePermissionRows,
	callerId: string,
): Promise<Map<string, OsCollaboratorRole>> {
	if (workspace.visibility === "private") {
		return new Map(
			workspace.ownerUserId ? [[workspace.ownerUserId, "build"] as const] : [],
		);
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
	return new Map(
		members.flatMap((member) => {
			const role = ORG_ROLE[member.role];
			return role ? [[member.userId, role] as const] : [];
		}),
	);
}

async function loadAccess(
	database: DbQueryClient,
	workspace: OsWorkspaceRow,
	callerId: string,
): Promise<WorkspaceAccess> {
	const rows = await loadOsWorkspacePermissionRows(database, {
		organizationId: workspace.organizationId,
		workspaceId: workspace.id,
	});
	const roots = await loadRoots(database, workspace, rows, callerId);
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
	};
}

async function findWorkspace(
	database: DbQueryClient,
	workspaceId: string,
): Promise<OsWorkspaceRow> {
	const workspace = await getOsWorkspaceForCollaboration(database, {
		workspaceId,
	});
	if (!workspace || workspace.status !== "active")
		throw createError(ErrorCodes.NOT_FOUND, "Workspace not found");
	return workspace;
}

/**
 * Load the caller's access and require an operation. A caller with no role
 * learns nothing about the workspace; a caller with a role but not this
 * operation gets FORBIDDEN for the operation only.
 */
export async function requireWorkspaceCollaboratorAccess(
	context: BaseContext,
	workspaceId: string,
	operation: OsWorkspaceOperation,
): Promise<WorkspaceAccess> {
	const callerId = requireCollaboratorIdentity(context);
	const database = db(context);
	const access = await loadAccess(
		database,
		await findWorkspace(database, workspaceId),
		callerId,
	);
	if (!access.role) throw createError(ErrorCodes.FORBIDDEN, ACCESS_DENIED);
	if (!operationAllowed(access.role, operation))
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Your role in this workspace doesn't allow that",
		);
	return access;
}

/**
 * True when `userId` is a `build` collaborator of a private workspace. The
 * organization-scoped workspace routes use this to let build collaborators
 * in; `use` collaborators only ever reach the workspace through `open`.
 */
export async function isOsWorkspaceBuildCollaborator(
	context: BaseContext,
	workspace: OsWorkspaceRow,
	userId: string,
): Promise<boolean> {
	try {
		const access = await loadAccess(db(context), workspace, userId);
		return !access.isRoot && access.role === "build";
	} catch (error) {
		// Fail closed: this runs only on the path that would otherwise deny.
		console.warn("os_collaborator_access_check_failed", {
			workspaceId: workspace.id,
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}

async function ownerName(
	database: DbQueryClient,
	workspace: OsWorkspaceRow,
): Promise<string | null> {
	if (workspace.visibility === "private" && workspace.ownerUserId) {
		const [owner] = await listTedixPeople(database, [workspace.ownerUserId]);
		return owner?.name ?? owner?.email ?? null;
	}
	const organization = await getOrganizationProfile(
		database,
		workspace.organizationId,
	);
	return organization?.name ?? null;
}

async function openedApps(database: DbQueryClient, workspace: OsWorkspaceRow) {
	const gadgets = await listOsGadgets(database, workspace.organizationId, {
		workspaceId: workspace.id,
		status: "active",
		limit: 50,
	});
	return Promise.all(
		gadgets.map(async (gadget) => {
			const revision = gadget.currentRevisionId
				? await getOsGadgetRevision(database, {
						organizationId: workspace.organizationId,
						revisionId: gadget.currentRevisionId,
					})
				: null;
			let entry: string | null = null;
			try {
				const manifest = revision
					? (JSON.parse(revision.manifest) as { entry?: unknown })
					: null;
				entry = typeof manifest?.entry === "string" ? manifest.entry : null;
			} catch {
				entry = null;
			}
			return {
				id: gadget.id,
				name: gadget.name,
				description: gadget.description,
				entry,
			};
		}),
	);
}

/**
 * Redeem an optional share key and open the workspace in one call. The
 * returned capability carries the role computed on this open and the
 * operations it allows; a runtime checks every call against it.
 */
export async function openWorkspaceAsCollaborator(
	context: BaseContext,
	input: { workspaceId: string; appId?: string; shareKey?: string },
) {
	const callerId = requireCollaboratorIdentity(context);
	const database = db(context);
	const workspace = await findWorkspace(database, input.workspaceId);
	const now = new Date().toISOString();
	if (input.shareKey) {
		const link = await getActiveOsWorkspaceShareLinkByKeyHash(database, {
			workspaceId: workspace.id,
			keyHash: await hashWorkspaceShareKey(input.shareKey),
		});
		if (link) {
			const pre = await loadAccess(database, workspace, callerId);
			if (!pre.isRoot) {
				const [person] = await listTedixPeople(database, [callerId]);
				await grantOsWorkspaceAccess(database, {
					organizationId: workspace.organizationId,
					workspaceId: workspace.id,
					now,
					edges: [
						{
							kind: "link",
							linkId: link.id,
							targetUserId: callerId,
							targetEmail: person?.email ?? context.user?.email ?? null,
							targetName: person?.name ?? null,
						},
					],
				});
			}
		}
	}
	const access = await loadAccess(database, workspace, callerId);
	if (!access.role) throw createError(ErrorCodes.FORBIDDEN, ACCESS_DENIED);
	if (input.appId) {
		const gadget = await getOsGadget(database, {
			organizationId: workspace.organizationId,
			gadgetId: input.appId,
		});
		if (
			!gadget ||
			gadget.workspaceId !== workspace.id ||
			gadget.status !== "active"
		)
			throw createError(ErrorCodes.NOT_FOUND, "App not found");
	}
	const owner = await ownerName(database, workspace);
	if (!access.isRoot) {
		await recordOsWorkspaceCollaboratorOpen(database, {
			organizationId: workspace.organizationId,
			workspaceId: workspace.id,
			userId: callerId,
			title: workspace.name,
			ownerName: owner,
			now,
		});
	}
	const capability: OsWorkspaceCapability = {
		workspaceId: workspace.id,
		appId: input.appId ?? null,
		role: access.role,
		operations: operationsForRole(access.role),
		actingUserId: callerId,
		openedAt: now,
	};
	return {
		workspace: { id: workspace.id, title: workspace.name, ownerName: owner },
		role: access.role,
		isOwner: access.isRoot,
		capability,
		apps: await openedApps(database, workspace),
	};
}

/** The only collaborator fields a live workspace roster may disclose. */
export async function getWorkspacePresenceIdentity(
	context: BaseContext,
	workspaceId: string,
) {
	const access = await requireWorkspaceCollaboratorAccess(
		context,
		workspaceId,
		"presence.read",
	);
	const [person] = await listTedixPeople(db(context), [access.callerId]);
	return {
		workspaceId: access.workspace.id,
		displayName: person?.name?.trim() || "Tedix member",
		role:
			access.workspace.visibility === "private" &&
			access.workspace.ownerUserId === access.callerId
				? ("owner" as const)
				: access.role!,
	};
}

async function people(
	database: DbQueryClient,
	access: WorkspaceAccess,
	userIds: readonly string[],
): Promise<Map<string, TedixPersonResult>> {
	const known = new Map<string, TedixPersonResult>();
	for (const row of access.rows.collaborators)
		known.set(row.userId, {
			userId: row.userId,
			email: row.email ?? "",
			name: row.name,
		});
	const missing = userIds.filter((id) => !known.has(id));
	for (const person of await listTedixPeople(database, missing))
		known.set(person.userId, person);
	return known;
}

function personView(directory: Map<string, TedixPersonResult>, userId: string) {
	const person = directory.get(userId);
	return {
		userId,
		email: person?.email || null,
		name: person?.name ?? null,
	};
}

function callerHasOwnEdge(access: WorkspaceAccess, targetId: string): boolean {
	return access.rows.edges.some(
		(edge) =>
			edge.kind === "user" &&
			edge.targetUserId === targetId &&
			edge.sharerUserId === access.callerId,
	);
}

export async function listWorkspaceSharing(
	context: BaseContext,
	workspaceId: string,
) {
	const access = await requireWorkspaceCollaboratorAccess(
		context,
		workspaceId,
		"sharing.read",
	);
	const database = db(context);
	const ids = new Set<string>();
	for (const edge of access.rows.edges) {
		ids.add(edge.targetUserId);
		if (edge.sharerUserId) ids.add(edge.sharerUserId);
	}
	for (const link of access.rows.links) ids.add(link.creatorUserId);
	const directory = await people(database, access, [...ids]);
	const label = (userId: string) => {
		const person = personView(directory, userId);
		return person.name ?? person.email ?? "Someone";
	};
	const collaborators: OsCollaborator[] = access.rows.collaborators
		.filter((row) => !access.graph.roots.has(row.userId))
		.flatMap((row) => {
			const role = access.roles.get(row.userId);
			if (!role) return [];
			const addedBy = access.rows.edges
				.filter((edge) => edge.targetUserId === row.userId)
				.map((edge) => {
					if (edge.kind === "user" && edge.sharerUserId)
						return access.roles.has(edge.sharerUserId)
							? label(edge.sharerUserId)
							: null;
					const link = access.rows.links.find((l) => l.id === edge.linkId);
					return link && !link.revokedAt
						? `Link${link.label ? ` "${link.label}"` : ""}`
						: null;
				})
				.filter((value): value is string => value !== null);
			return [
				{
					...personView(directory, row.userId),
					role,
					addedBy,
					canRemove: access.isRoot || callerHasOwnEdge(access, row.userId),
					lastOpenedAt: row.lastOpenedAt,
				},
			];
		});
	const links: OsCollaboratorLink[] = access.rows.links
		.filter((link) => !link.revokedAt)
		.map((link) => ({
			id: link.id,
			role: link.role,
			label: link.label,
			createdBy: personView(directory, link.creatorUserId),
			createdAt: link.createdAt,
			canRevoke: access.isRoot || link.creatorUserId === access.callerId,
		}));
	return {
		role: access.role as OsCollaboratorRole,
		isOwner: access.isRoot,
		ownerName: await ownerName(database, access.workspace),
		collaborators,
		links,
	};
}

function requireGrantable(
	access: WorkspaceAccess,
	role: OsCollaboratorRole,
): void {
	if (!collaboratorRoleAtLeast(access.role, role))
		throw createError(
			ErrorCodes.FORBIDDEN,
			"You can't grant a role higher than your own",
		);
}

export async function addWorkspaceCollaborator(
	context: BaseContext,
	input: { workspaceId: string; email: string; role: OsCollaboratorRole },
): Promise<OsCollaborator> {
	const access = await requireWorkspaceCollaboratorAccess(
		context,
		input.workspaceId,
		"sharing.write",
	);
	requireGrantable(access, input.role);
	const database = db(context);
	const person = await findTedixPersonByEmail(database, input.email);
	if (!person)
		throw createError(
			ErrorCodes.NOT_FOUND,
			"No Tedix account uses that email. Send them a share link instead.",
		);
	if (
		person.userId === access.callerId ||
		access.graph.roots.has(person.userId)
	)
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"That person already has full access",
		);
	await grantOsWorkspaceAccess(database, {
		organizationId: access.workspace.organizationId,
		workspaceId: access.workspace.id,
		now: new Date().toISOString(),
		edges: [
			{
				kind: "user",
				targetUserId: person.userId,
				targetEmail: person.email,
				targetName: person.name,
				sharerUserId: access.callerId,
				role: input.role,
			},
		],
	});
	const after = await loadAccess(database, access.workspace, access.callerId);
	const [sharer] = await listTedixPeople(database, [access.callerId]);
	return {
		userId: person.userId,
		email: person.email,
		name: person.name,
		role: after.roles.get(person.userId) ?? input.role,
		addedBy: [sharer?.name ?? sharer?.email ?? "You"],
		canRemove: true,
		lastOpenedAt: null,
	};
}

export async function createWorkspaceShareLink(
	context: BaseContext,
	input: { workspaceId: string; role: OsCollaboratorRole; label?: string },
): Promise<{ link: OsCollaboratorLink; key: string }> {
	const access = await requireWorkspaceCollaboratorAccess(
		context,
		input.workspaceId,
		"sharing.write",
	);
	requireGrantable(access, input.role);
	const key = generateWorkspaceShareKey();
	const database = db(context);
	const link = await createOsWorkspaceShareLink(database, {
		organizationId: access.workspace.organizationId,
		workspaceId: access.workspace.id,
		id: crypto.randomUUID(),
		creatorUserId: access.callerId,
		role: input.role,
		label: input.label?.trim() || null,
		keyHash: await hashWorkspaceShareKey(key),
		now: new Date().toISOString(),
	});
	const [creator] = await listTedixPeople(database, [access.callerId]);
	return {
		key,
		link: {
			id: link.id,
			role: link.role,
			label: link.label,
			createdBy: {
				userId: access.callerId,
				email: creator?.email ?? null,
				name: creator?.name ?? null,
			},
			createdAt: link.createdAt,
			canRevoke: true,
		},
	};
}

export async function copyWorkspaceShareLink(
	context: BaseContext,
	input: { workspaceId: string; linkId: string },
): Promise<{ key: string }> {
	const access = await requireWorkspaceCollaboratorAccess(
		context,
		input.workspaceId,
		"sharing.write",
	);
	const key = generateWorkspaceShareKey();
	const added = await addOsWorkspaceShareKey(db(context), {
		organizationId: access.workspace.organizationId,
		workspaceId: access.workspace.id,
		linkId: input.linkId,
		keyHash: await hashWorkspaceShareKey(key),
		now: new Date().toISOString(),
	});
	if (!added) throw createError(ErrorCodes.NOT_FOUND, "Share link not found");
	return { key };
}

type RemovalPlan = {
	change: GraphChange;
	sharerUserId?: string;
};

function planRemoval(
	access: WorkspaceAccess,
	target: OsCollaboratorTarget,
): RemovalPlan {
	if (target.kind === "link") {
		const link = access.rows.links.find((row) => row.id === target.linkId);
		if (!link || link.revokedAt)
			throw createError(ErrorCodes.NOT_FOUND, "Share link not found");
		if (!access.isRoot && link.creatorUserId !== access.callerId)
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Only the owner or the link's creator can revoke it",
			);
		return { change: { revokedLinkId: link.id } };
	}
	if (access.graph.roots.has(target.userId))
		throw createError(ErrorCodes.BAD_REQUEST, "The owner can't be removed");
	if (access.isRoot) return { change: { removedUserId: target.userId } };
	if (!callerHasOwnEdge(access, target.userId))
		throw createError(
			ErrorCodes.FORBIDDEN,
			"You can only remove people you added",
		);
	return {
		change: {
			removedEdge: { targetId: target.userId, sharerId: access.callerId },
		},
		sharerUserId: access.callerId,
	};
}

async function affectedView(
	context: BaseContext,
	access: WorkspaceAccess,
	changes: RoleChange[],
): Promise<OsAffectedCollaborator[]> {
	const directory = await people(
		db(context),
		access,
		changes.map((change) => change.userId),
	);
	return changes
		.filter((change) => !access.graph.roots.has(change.userId))
		.map((change) => ({
			...personView(directory, change.userId),
			oldRole: change.oldRole,
			newRole: change.newRole,
		}));
}

export async function previewWorkspaceRemoval(
	context: BaseContext,
	input: { workspaceId: string; target: OsCollaboratorTarget },
): Promise<OsAffectedCollaborator[]> {
	const access = await requireWorkspaceCollaboratorAccess(
		context,
		input.workspaceId,
		"sharing.write",
	);
	const plan = planRemoval(access, input.target);
	const after = computeEffectiveRoles(access.graph, plan.change);
	return affectedView(context, access, diffRoles(access.roles, after));
}

export async function removeWorkspaceAccess(
	context: BaseContext,
	input: {
		workspaceId: string;
		target: OsCollaboratorTarget;
		keepUserIds: string[];
	},
): Promise<OsAffectedCollaborator[]> {
	const access = await requireWorkspaceCollaboratorAccess(
		context,
		input.workspaceId,
		"sharing.write",
	);
	const plan = planRemoval(access, input.target);
	const predicted = computeEffectiveRoles(access.graph, plan.change);
	const affected = diffRoles(access.roles, predicted);
	const callerRoleAfter = predicted.get(access.callerId);
	const removedId =
		input.target.kind === "user" ? input.target.userId : undefined;
	const keepEdges: OsWorkspaceEdgeInput[] = callerRoleAfter
		? planKeptUserEdges({
				callerId: access.callerId,
				callerRole: callerRoleAfter,
				affected: affected.filter((change) => change.userId !== removedId),
				keepUserIds: input.keepUserIds,
			}).map((edge) => {
				const row = access.rows.collaborators.find(
					(c) => c.userId === edge.targetId,
				);
				return {
					kind: "user",
					targetUserId: edge.targetId,
					targetEmail: row?.email ?? null,
					targetName: row?.name ?? null,
					sharerUserId: edge.sharerId,
					role: edge.role,
				};
			})
		: [];
	const database = db(context);
	const scope = {
		organizationId: access.workspace.organizationId,
		workspaceId: access.workspace.id,
		keepEdges,
		now: new Date().toISOString(),
	};
	if (input.target.kind === "link") {
		await revokeOsWorkspaceShareLink(database, {
			...scope,
			linkId: input.target.linkId,
		});
	} else {
		await severOsWorkspaceUserAccess(database, {
			...scope,
			targetUserId: input.target.userId,
			sharerUserId: plan.sharerUserId,
		});
	}
	const after = await loadAccess(database, access.workspace, access.callerId);
	const fell = diffRoles(access.roles, after.roles);
	// Anyone whose role fell may still hold a signed app session or be inside
	// an app call; the workspace's app host cuts them and restarts its apps.
	await cutWorkspaceAppSessions(context.env, {
		organizationId: access.workspace.organizationId,
		workspaceId: access.workspace.id,
		principalIds: fell.map((change) => change.userId),
	});
	return affectedView(context, access, fell);
}
