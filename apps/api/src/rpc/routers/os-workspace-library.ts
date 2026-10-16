import { implement } from "@orpc/server";
import { osWorkspacesContract } from "@tedix/api-contract/contracts/os-workspaces";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	type OsCreatedByKind,
	type OsWorkspace,
	type OsWorkspacePreference,
	OsBlueprintPreflightSchema,
	OsWorkspaceBlueprintDecisionSchema,
	OsWorkspacePreferenceSchema,
} from "@tedix/api-contract/schemas/os-workspaces";
import { listOsCollaborationProposals } from "@tedix/db/queries/os-workspaces/collaboration";
import { listOsShareLinks } from "@tedix/db/queries/os-shares";
import {
	createOsWorkspace,
	deleteOsWorkspace,
	getOsWorkspace,
	getOsWorkspaceByName,
	getPersonalOsWorkspace,
	listOsWorkspaces,
	saveConversationAsOsWorkspace,
	updateOsWorkspace,
} from "@tedix/db/queries/os-workspaces/workspaces";
import { getKernelConversation } from "@tedix/db/queries/kernel-conversations";
import { getMemberByUserId } from "@tedix/db/queries/organization-members";
import {
	getUserConfig,
	listUserConfigs,
	upsertUserConfig,
} from "@tedix/db/queries/user-configs";
import { createDbQueryClient } from "@tedix/db/query-client";
import type { OsWorkspaceRow } from "@tedix/db/schema/os-workspaces";
import { requireOrgId } from "../org-scope";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	userHoldsPermission,
	withAuth,
} from "../orpc";
import { OS_WORKSPACES_AUDIT, osAudit } from "../os-audit";
import {
	assertOsWorkspaceVisible,
	resolveOsWorkspaceOwnerCandidate,
	resolveOsWorkspaceViewer,
} from "../../services/os-workspace-visibility";
import { resolveKernelConversationAccess } from "../../kernel/conversation-access";
import { DEFAULT_OS_WORKSPACE_NAME } from "../../services/os-default-workspace";

const os = implement(osWorkspacesContract).$context<BaseContext>();
const authed = os.use(withAuth).use(osAudit(OS_WORKSPACES_AUDIT));
const readOs = authed.use(AUTHZ.osRead);
const authorOs = authed.use(AUTHZ.osAuthor);
const adminOs = authed.use(AUTHZ.osAdmin);

function queryDb(context: BaseContext) {
	return createDbQueryClient(context.env.DB);
}

function parsePreflight(value: string | null) {
	if (!value) return null;
	try {
		const parsed = OsBlueprintPreflightSchema.safeParse(JSON.parse(value));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

function parseDecision(value: string | null) {
	if (!value) return null;
	try {
		const parsed = OsWorkspaceBlueprintDecisionSchema.safeParse(
			JSON.parse(value),
		);
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

function mapWorkspace(row: OsWorkspaceRow): OsWorkspace {
	return {
		id: row.id,
		organizationId: row.organizationId,
		name: row.name,
		description: row.description,
		status: row.status,
		sourceBlueprintId: row.sourceBlueprintId,
		sourceBlueprintRevisionId: row.sourceBlueprintRevisionId,
		sourceBlueprintRevisionNumber: row.sourceBlueprintRevisionNumber,
		instantiationPreflight: parsePreflight(row.instantiationPreflight),
		rollbackReference:
			row.previousBlueprintRevisionId &&
			row.previousBlueprintRevisionNumber !== null
				? {
						revisionId: row.previousBlueprintRevisionId,
						revision: row.previousBlueprintRevisionNumber,
						preflight: parsePreflight(row.previousInstantiationPreflight),
					}
				: null,
		blueprintDecision: parseDecision(row.blueprintDecision),
		createdByKind: row.createdByKind,
		createdById: row.createdById,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		visibility: row.visibility,
		ownerUserId: row.ownerUserId,
	};
}

function creator(context: BaseContext): { kind: OsCreatedByKind; id: string } {
	if (context.externalAgentPrincipalId) {
		return { kind: "external_agent", id: context.externalAgentPrincipalId };
	}
	if (context.tediId) return { kind: "tedi", id: context.tediId };
	if (context.authType === "user" && context.user?.sub) {
		return { kind: "user", id: context.user.sub };
	}
	if (context.authType === "apikey" && context.apiKey?.id) {
		return { kind: "service", id: context.apiKey.id };
	}
	if (context.serviceAccount?.clientId) {
		return { kind: "service", id: context.serviceAccount.clientId };
	}
	throw createError(
		ErrorCodes.FORBIDDEN,
		"No accountable principal for a Tedix OS workspace write",
	);
}

function isUniqueConstraintError(error: unknown): boolean {
	for (let cursor = error; cursor instanceof Error; cursor = cursor.cause) {
		if (/unique constraint/i.test(cursor.message)) return true;
	}
	return false;
}

function rethrowNameConflict(error: unknown): never {
	if (isUniqueConstraintError(error)) {
		throw createError(
			ErrorCodes.CONFLICT,
			"A workspace with this name already exists in the organization",
			error,
		);
	}
	throw error;
}

async function requireWorkspace(context: BaseContext, workspaceId: string) {
	const organizationId = requireOrgId(context);
	const workspace = await getOsWorkspace(queryDb(context), {
		organizationId,
		workspaceId,
	});
	if (!workspace) {
		throw createError(ErrorCodes.NOT_FOUND, "OS workspace not found");
	}
	await assertOsWorkspaceVisible(context, workspace);
	return workspace;
}

/**
 * The member who will own a private workspace: the one human the caller acts
 * for. Machine principals cannot own one.
 */
async function requirePrivateOwner(context: BaseContext): Promise<string> {
	const owner = await resolveOsWorkspaceOwnerCandidate(context);
	if (!owner) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"A private workspace needs a member to own it; call as that member or their own tedi",
		);
	}
	return owner;
}

/**
 * Visibility patch for update. Making a workspace private hides it from every
 * other member, so only the member who created it may do that; sharing a
 * private workspace again is the owner's call (non-owners never reach here,
 * because requireWorkspace already hid it from them). With `ownerUserId` a
 * private workspace is given to another member (see `giveToMember`).
 */
async function visibilityPatch(
	context: BaseContext,
	workspace: OsWorkspaceRow,
	visibility: OsWorkspaceRow["visibility"] | undefined,
	ownerUserId: string | undefined,
): Promise<Pick<OsWorkspaceRow, "visibility" | "ownerUserId"> | null> {
	if (ownerUserId !== undefined) {
		if ((visibility ?? workspace.visibility) !== "private") {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Only a private workspace has an owner; send visibility private",
			);
		}
		return giveToMember(context, workspace, ownerUserId);
	}
	if (!visibility || visibility === workspace.visibility) return null;
	if (visibility === "org") return { visibility, ownerUserId: null };
	const owner = await requirePrivateOwner(context);
	if (workspace.createdByKind !== "user" || workspace.createdById !== owner) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Only the member who created this workspace can make it private",
		);
	}
	return { visibility, ownerUserId: owner };
}

/**
 * Give a workspace to one member as a private workspace. A signed-in person
 * may do it when they own it now (its private owner, or the member who
 * created an org workspace), or when they administer the organization and
 * give an org workspace to someone else. The new owner must be an active
 * member. Afterwards only the new owner sees it, the giver included.
 */
async function giveToMember(
	context: BaseContext,
	workspace: OsWorkspaceRow,
	ownerUserId: string,
): Promise<Pick<OsWorkspaceRow, "visibility" | "ownerUserId">> {
	const caller =
		context.authType === "user" && !context.tediId ? context.user?.sub : null;
	const ownsIt =
		Boolean(caller) &&
		(workspace.visibility === "private"
			? workspace.ownerUserId === caller
			: workspace.createdByKind === "user" && workspace.createdById === caller);
	const adminForMember =
		workspace.visibility === "org" &&
		ownerUserId !== caller &&
		userHoldsPermission(context, "settings:manage");
	if (!caller || !(ownsIt || adminForMember)) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Only the workspace's owner, or an organization admin giving it to a member, can choose its owner",
		);
	}
	const member = await getMemberByUserId(
		context.db,
		requireOrgId(context),
		ownerUserId,
	);
	if (member?.status !== "active") {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"The new owner must be an active member of this organization",
		);
	}
	return { visibility: "private", ownerUserId };
}

const list = readOs.workspaces.list.handler(async ({ input, context }) => {
	const rows = await listOsWorkspaces(
		queryDb(context),
		requireOrgId(context),
		await resolveOsWorkspaceViewer(context),
		{
			status: input.status,
			limit: input.limit + 1,
		},
	);
	return {
		items: rows.slice(0, input.limit).map(mapWorkspace),
		truncated: rows.length > input.limit,
	};
});

const create = authorOs.workspaces.create.handler(
	async ({ input, context }) => {
		const accountable = creator(context);
		const timestamp = new Date().toISOString();
		const ownerUserId =
			input.visibility === "private"
				? await requirePrivateOwner(context)
				: null;
		try {
			const row = await createOsWorkspace(queryDb(context), {
				id: crypto.randomUUID(),
				organizationId: requireOrgId(context),
				name: input.name,
				description: input.description ?? null,
				status: "active",
				visibility: ownerUserId ? "private" : "org",
				ownerUserId,
				createdByKind: accountable.kind,
				createdById: accountable.id,
				createdAt: timestamp,
				updatedAt: timestamp,
			});
			return { workspace: mapWorkspace(row) };
		} catch (error) {
			rethrowNameConflict(error);
		}
	},
);

/**
 * "Save as workspace" on a chat: a new workspace holding that conversation and
 * the outputs it made. A conversation already in a workspace is refused.
 */
const createFromConversation =
	authorOs.workspaces.createFromConversation.handler(
		async ({ input, context }) => {
			const organizationId = requireOrgId(context);
			const access = await resolveKernelConversationAccess(context.db, {
				conversationId: input.conversationId,
				descopeUserId: context.descopeUserId ?? context.user?.sub ?? null,
				organizationId,
				required: "edit",
			});
			if (!access.allowed) {
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Access denied to this conversation",
				);
			}
			const db = queryDb(context);
			// A chat belongs to the member who saves it, so its workspace stays
			// private to them (its outputs may already sit in their private space).
			const owner = await resolveOsWorkspaceOwnerCandidate(context);
			const [conversation, general, personal] = await Promise.all([
				getKernelConversation(context.db, {
					organizationId,
					conversationId: input.conversationId,
				}),
				getOsWorkspaceByName(db, {
					organizationId,
					name: DEFAULT_OS_WORKSPACE_NAME,
				}),
				owner
					? getPersonalOsWorkspace(db, { organizationId, ownerUserId: owner })
					: undefined,
			]);
			if (!conversation || conversation.deletedAt) {
				throw createError(ErrorCodes.NOT_FOUND, "Conversation not found");
			}
			if (conversation.workspaceId) {
				throw createError(
					ErrorCodes.CONFLICT,
					"This conversation already belongs to a workspace",
				);
			}
			const accountable = creator(context);
			const timestamp = new Date().toISOString();
			const workspaceId = crypto.randomUUID();
			const save = (name: string) =>
				saveConversationAsOsWorkspace(db, {
					workspace: {
						id: workspaceId,
						organizationId,
						name,
						description: input.description ?? null,
						status: "active",
						visibility: owner ? "private" : "org",
						ownerUserId: owner,
						createdByKind: accountable.kind,
						createdById: accountable.id,
						createdAt: timestamp,
						updatedAt: timestamp,
					},
					conversationId: input.conversationId,
					fromWorkspaceIds: [
						...(general?.visibility === "org" ? [general.id] : []),
						...(personal ? [personal.id] : []),
					],
				});
			let saved;
			try {
				saved = await save(input.name);
			} catch (error) {
				if (!isUniqueConstraintError(error)) throw error;
				try {
					saved = await save(
						`${input.name.slice(0, 109).trimEnd()} · ${workspaceId.slice(0, 8)}`,
					);
				} catch (retryError) {
					rethrowNameConflict(retryError);
				}
			}
			return {
				workspace: mapWorkspace(saved.workspace),
				movedOutputIds: saved.movedOutputIds,
			};
		},
	);

const get = readOs.workspaces.get.handler(async ({ input, context }) => ({
	workspace: mapWorkspace(await requireWorkspace(context, input.workspaceId)),
}));

const update = authorOs.workspaces.update.handler(
	async ({ input, context }) => {
		const workspace = await requireWorkspace(context, input.workspaceId);
		const visibility = await visibilityPatch(
			context,
			workspace,
			input.visibility,
			input.ownerUserId,
		);
		try {
			const row = await updateOsWorkspace(
				queryDb(context),
				{
					organizationId: requireOrgId(context),
					workspaceId: input.workspaceId,
				},
				{
					...(input.name !== undefined ? { name: input.name } : {}),
					...(input.description !== undefined
						? { description: input.description }
						: {}),
					...visibility,
				},
			);
			if (!row) {
				throw createError(ErrorCodes.NOT_FOUND, "OS workspace not found");
			}
			return { workspace: mapWorkspace(row) };
		} catch (error) {
			rethrowNameConflict(error);
		}
	},
);

const archive = authorOs.workspaces.archive.handler(
	async ({ input, context }) => {
		await requireWorkspace(context, input.workspaceId);
		const row = await updateOsWorkspace(
			queryDb(context),
			{
				organizationId: requireOrgId(context),
				workspaceId: input.workspaceId,
			},
			{ status: "archived" },
		);
		if (!row) {
			throw createError(ErrorCodes.NOT_FOUND, "OS workspace not found");
		}
		return { workspace: mapWorkspace(row) };
	},
);

const restore = authorOs.workspaces.restore.handler(
	async ({ input, context }) => {
		await requireWorkspace(context, input.workspaceId);
		const row = await updateOsWorkspace(
			queryDb(context),
			{
				organizationId: requireOrgId(context),
				workspaceId: input.workspaceId,
			},
			{ status: "active" },
		);
		if (!row) {
			throw createError(ErrorCodes.NOT_FOUND, "OS workspace not found");
		}
		return { workspace: mapWorkspace(row) };
	},
);

const deleteWorkspace = adminOs.workspaces.delete.handler(
	async ({ input, context }) => {
		const workspace = await requireWorkspace(context, input.workspaceId);
		if (workspace.status !== "archived") {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Archive the workspace before permanently deleting it",
			);
		}
		const proposals = await listOsCollaborationProposals(
			queryDb(context),
			workspace.organizationId,
			{ workspaceId: workspace.id, limit: 1 },
		);
		if (proposals.length > 0) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Workspace has retained collaboration evidence and cannot be permanently deleted",
			);
		}
		const shares = await listOsShareLinks(queryDb(context), {
			organizationId: workspace.organizationId,
			resourceType: "workspace",
			resourceId: workspace.id,
		});
		if (shares.some((share) => share.revokedAt === null)) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Revoke every share link before permanently deleting the workspace",
			);
		}
		const removed = await deleteOsWorkspace(queryDb(context), {
			organizationId: workspace.organizationId,
			workspaceId: workspace.id,
			preferenceNamespace: preferenceNamespace(workspace.organizationId),
		});
		if (!removed) {
			throw createError(ErrorCodes.NOT_FOUND, "OS workspace not found");
		}
		return { deleted: true as const };
	},
);

const preferenceNamespace = (organizationId: string) =>
	`tedix-os-workspaces:${organizationId}`;

function requirePersonalUser(context: BaseContext): string {
	if (
		context.authType !== "user" ||
		!context.user?.sub ||
		context.externalAgentPrincipalId ||
		context.tediId
	) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Workspace favorites and recency require a human user session",
		);
	}
	return context.user.sub;
}

function mapPreference(input: {
	key: string;
	value: Record<string, JsonValue>;
	updatedAt: string | null;
}): OsWorkspacePreference | null {
	const parsed = OsWorkspacePreferenceSchema.safeParse({
		workspaceId: input.key,
		favorite:
			typeof input.value.favorite === "boolean" ? input.value.favorite : false,
		lastOpenedAt:
			typeof input.value.lastOpenedAt === "string"
				? input.value.lastOpenedAt
				: null,
		updatedAt: input.updatedAt,
	});
	return parsed.success ? parsed.data : null;
}

async function readPreference(
	context: BaseContext,
	workspace: Pick<OsWorkspaceRow, "id" | "organizationId">,
) {
	const row = await getUserConfig(queryDb(context), {
		userId: requirePersonalUser(context),
		namespace: preferenceNamespace(workspace.organizationId),
		key: workspace.id,
	});
	return row ? mapPreference(row) : null;
}

async function writePreference(
	context: BaseContext,
	workspace: Pick<OsWorkspaceRow, "id" | "organizationId">,
	value: { favorite: boolean; lastOpenedAt: string | null },
) {
	const row = await upsertUserConfig(queryDb(context), {
		userId: requirePersonalUser(context),
		namespace: preferenceNamespace(workspace.organizationId),
		key: workspace.id,
		value,
	});
	const preference = mapPreference(row);
	if (!preference) {
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			"Saved workspace preference could not be read",
		);
	}
	return preference;
}

const listPreferences = readOs.workspacePreferences.list.handler(
	async ({ context }) => {
		const organizationId = requireOrgId(context);
		const rows = await listUserConfigs(queryDb(context), {
			userId: requirePersonalUser(context),
			namespace: preferenceNamespace(organizationId),
			limit: 500,
		});
		return {
			items: rows.flatMap((row) => {
				const preference = mapPreference(row);
				return preference ? [preference] : [];
			}),
		};
	},
);

const setFavorite = readOs.workspacePreferences.setFavorite.handler(
	async ({ input, context }) => {
		const workspace = await requireWorkspace(context, input.workspaceId);
		const current = await readPreference(context, workspace);
		return {
			preference: await writePreference(context, workspace, {
				favorite: input.favorite,
				lastOpenedAt: current?.lastOpenedAt ?? null,
			}),
		};
	},
);

const touch = readOs.workspacePreferences.touch.handler(
	async ({ input, context }) => {
		const workspace = await requireWorkspace(context, input.workspaceId);
		const current = await readPreference(context, workspace);
		return {
			preference: await writePreference(context, workspace, {
				favorite: current?.favorite ?? false,
				lastOpenedAt: new Date().toISOString(),
			}),
		};
	},
);

export const osWorkspaceProcedures = {
	list,
	create,
	createFromConversation,
	get,
	update,
	archive,
	restore,
	delete: deleteWorkspace,
};
export const osWorkspacePreferenceProcedures = {
	list: listPreferences,
	setFavorite,
	touch,
};
