import {
	discoverWorkspaceConnections,
	requireConnectionSender,
} from "../../services/workspace-available-connections";
import { adoptDefaultPersonalConnection } from "./connections/policy-resolution";
import { coreQueryDb } from "@tedix/db/core-store/scope";
import {
	createConnectionInstance,
	listConnectionInstances,
	recordConnectionGrant,
} from "@tedix/db/queries/connection-instances";
import { personalResourceScopesCover } from "@tedix/api-contract/utils/personal-resource-tool-binding";
import { scopesGrantingConsent } from "@tedix/api-contract/utils/provider-capability-profiles";
import { fetchNamedConnection } from "./connections/policy-resolution";
import {
	supportedCalendarAccounts,
	calendarOwnerUser,
	resolveCalendarAdapter,
} from "../../services/calendar-coordinator/credentials";
import { getConnectionInstance } from "@tedix/db/queries/connection-instances";
import { getSkillEntry } from "@tedix/db/queries/cognitive/skill-crud";
import { implement } from "@orpc/server";
import { osWorkspacesContract } from "@tedix/api-contract/contracts/os-workspaces";
import {
	type OsWorkspaceResource,
	type OsWorkspaceResourceSelection,
	OsWorkspaceResourceSchema,
} from "@tedix/api-contract/schemas/os-workspaces";
import {
	isWorkspaceLinkResource,
	isWorkspaceSkillResource,
} from "@tedix/api-contract/schemas/os-workspace-schedules";
import { listOsWorkspaceResources } from "@tedix/db/queries/os-workspaces/resources";
import {
	createOsWorkspaceResource,
	findOsWorkspaceTenantResource,
	getOsWorkspaceResource,
	removeOsWorkspaceResource,
	rebindOsWorkspaceResource,
	renameOsWorkspaceResource,
	restoreOsWorkspaceResource,
} from "../../services/workspace-resource-storage";

import type { OsWorkspaceResourceRow } from "@tedix/db/schema/os-workspaces";
import { requireOrgId } from "../org-scope";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
} from "../orpc";
import { OS_WORKSPACES_AUDIT, osAudit } from "../os-audit";
import { resolveWorkspaceResourceAvailability } from "../../services/os-workspace-resource-availability";
import {
	authorizeWorkspaceResourceRead,
	resolveWorkspacePersonalReadCredential,
} from "../../services/os-workspace-resource-read-authority";
import {
	listWorkspaceDriveFiles,
	readWorkspaceDriveFile,
} from "../../services/os-workspace-drive-read";
import { readWorkspaceDrivePdf } from "../../services/os-workspace-drive-pdf-read";
import { prepareWorkspaceRepositoryWork } from "../../services/os-workspace-repository-work";
import {
	isUniqueConstraintError,
	requireWorkspace,
	resolveCreator,
} from "./os-workspaces-shared";

const os = implement(osWorkspacesContract).$context<BaseContext>();
const authed = os.use(withAuth).use(osAudit(OS_WORKSPACES_AUDIT));
const readOs = authed.use(AUTHZ.osRead);
const authorOs = authed.use(AUTHZ.osAuthor);

function queryDb(context: BaseContext) {
	return coreQueryDb(context.env);
}

function parseJson(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

export function mapWorkspaceResource(
	row: OsWorkspaceResourceRow,
): OsWorkspaceResource {
	return OsWorkspaceResourceSchema.parse({
		...row,
		requiredScopes: parseJson(row.requiredScopes),
		metadata: parseJson(row.metadata),
	});
}

async function projectWorkspaceResource(
	context: BaseContext,
	row: OsWorkspaceResourceRow,
): Promise<OsWorkspaceResource> {
	const resource = mapWorkspaceResource(row);
	const availability = await resolveWorkspaceResourceAvailability(
		context,
		resource,
	);
	return OsWorkspaceResourceSchema.parse({ ...resource, availability });
}

async function requireResource(
	context: BaseContext,
	workspaceId: string,
	resourceId: string,
): Promise<OsWorkspaceResourceRow> {
	const organizationId = requireOrgId(context);
	const row = await getOsWorkspaceResource(queryDb(context), {
		organizationId,
		workspaceId,
		resourceId,
	});
	if (!row) {
		throw createError(ErrorCodes.NOT_FOUND, "Workspace resource not found");
	}
	await requireWorkspace(context, workspaceId);
	return row;
}

async function personalAccountBinding(
	context: BaseContext,
	scope: "tenant" | "user",
	providerId: string,
	instanceId?: string,
) {
	if (scope === "tenant") {
		if (!instanceId)
			return { personalOwnerUserId: null, connectionInstanceId: null };
		const instance = await getConnectionInstance(
			context.db,
			{ organizationId: requireOrgId(context) },
			instanceId,
			providerId,
		);
		if (!instance?.tokenSub || !instance.tokenIds.length)
			throw createError(
				ErrorCodes.FORBIDDEN,
				"The organization account is unavailable",
			);
		return { personalOwnerUserId: null, connectionInstanceId: instance.id };
	}
	if (
		context.authType !== "user" ||
		!context.user?.sub ||
		context.tediId ||
		!instanceId
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Select your exact connected personal account",
		);
	const instance = await getConnectionInstance(
		context.db,
		{ userId: context.user.sub },
		instanceId,
		providerId,
	);
	if (!instance || !instance.tokenIds.length || !instance.tokenSub)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"The exact personal account is unavailable or belongs to another owner",
		);
	return {
		personalOwnerUserId: context.user.sub,
		connectionInstanceId: instance.id,
	};
}

async function verifiedResourceScopes(
	context: BaseContext,
	selection: {
		providerId: string;
		connectionScope: "tenant" | "user";
		connectionInstanceId?: string;
		resourceType: string;
		providerResourceId: string;
		requiredScopes: string[];
		providerAccess?: { canRead: boolean; canWrite: boolean } | null;
	},
) {
	if (
		selection.providerId === "google-drive" &&
		["file", "folder"].includes(selection.resourceType)
	) {
		if (!/^[A-Za-z0-9_-]{1,255}$/.test(selection.providerResourceId))
			throw createError(ErrorCodes.BAD_REQUEST, "Invalid Drive object ID");
		return {
			requiredScopes: selection.requiredScopes,
			providerAccess: selection.providerAccess ?? {
				canRead: true,
				canWrite: false,
			},
		};
	}
	if (
		selection.resourceType !== "calendar" ||
		selection.connectionScope !== "user"
	)
		return { requiredScopes: selection.requiredScopes, providerAccess: null };
	if (!selection.connectionInstanceId)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Calendar attachment requires an exact named account",
		);
	const orgId = requireOrgId(context);
	const accounts = await supportedCalendarAccounts(
		context,
		orgId,
		selection.connectionScope,
	);
	const account = accounts.find(
		(account) =>
			account.providerId === selection.providerId &&
			account.connectionInstanceId === selection.connectionInstanceId,
	);
	if (!account)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"The selected account is not a supported calendar provider",
		);
	const resolved = await resolveCalendarAdapter(context, orgId, {
		...selection,
		connectionInstanceId: selection.connectionInstanceId,
		adapter: account.adapter,
	});
	const calendar = (await resolved.adapter.listCalendars()).find(
		(calendar) => calendar.id === selection.providerResourceId,
	);
	if (!calendar?.canRead)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"The selected calendar is not readable through this exact account",
		);
	const token = await fetchNamedConnection(
		context,
		{ userId: calendarOwnerUser(context) },
		selection.providerId,
		selection.connectionInstanceId,
	);
	const accountBinding = await getConnectionInstance(
		context.db,
		{ userId: calendarOwnerUser(context) },
		selection.connectionInstanceId,
		selection.providerId,
	);
	if (
		!token?.id ||
		!accountBinding?.tokenIds.includes(token.id) ||
		token.tokenSub !== accountBinding.tokenSub
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Calendar account identity changed during attachment",
		);
	const observed = token?.scopes ?? [];
	const requiredScopes = scopesGrantingConsent(
		account.adapter === "google"
			? "google-calendar-attach"
			: "microsoft-calendar-read",
		observed,
	);
	if (!requiredScopes.length)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Calendar credential has no verified calendar scopes",
		);
	if (!personalResourceScopesCover(observed, selection.requiredScopes))
		throw createError(
			ErrorCodes.FORBIDDEN,
			"The selected account did not grant the requested scopes",
		);
	return {
		requiredScopes,
		providerAccess: { canRead: calendar.canRead, canWrite: calendar.canWrite },
	};
}

/** Shared attachment admission for direct resources and Blueprint installation. */
export async function verifyWorkspaceResourceSelection(
	context: BaseContext,
	selection: OsWorkspaceResourceSelection,
) {
	const binding = await personalAccountBinding(
		context,
		selection.connectionScope,
		selection.providerId,
		selection.connectionInstanceId,
	);
	const verified = await verifiedResourceScopes(context, selection);
	return { ...binding, ...verified };
}

const list = readOs.resources.list.handler(async ({ input, context }) => {
	const workspace = await requireWorkspace(context, input.workspaceId);
	const rows = await listOsWorkspaceResources(queryDb(context), {
		organizationId: workspace.organizationId,
		workspaceId: workspace.id,
		status: input.status,
		limit: input.limit + 1,
		hideInactiveOutputs: true,
	});
	return {
		items: await Promise.all(
			rows
				.slice(0, input.limit)
				.map((row) => projectWorkspaceResource(context, row)),
		),
		truncated: rows.length > input.limit,
	};
});

/**
 * Attaching an organization resource that was removed from this Workspace
 * restores that reference with the new slot and name instead of failing on
 * the removed row. Returns undefined when nothing removed matches or the
 * slot is taken.
 */
async function restoreRemovedTenantResource(
	context: BaseContext,
	params: {
		organizationId: string;
		workspaceId: string;
		selection: OsWorkspaceResourceSelection;
		slot: string | null;
		requiredScopes: string;
		providerAccess: OsWorkspaceResourceRow["providerAccess"];
		now: string;
	},
): Promise<OsWorkspaceResourceRow | undefined> {
	if (
		params.selection.connectionScope !== "tenant" ||
		params.selection.connectionInstanceId
	)
		return undefined;
	const db = queryDb(context);
	const removed = await findOsWorkspaceTenantResource(db, {
		organizationId: params.organizationId,
		workspaceId: params.workspaceId,
		providerId: params.selection.providerId,
		resourceType: params.selection.resourceType,
		providerResourceId: params.selection.providerResourceId,
	});
	if (removed?.status !== "removed") return undefined;
	try {
		return await restoreOsWorkspaceResource(db, {
			organizationId: params.organizationId,
			workspaceId: params.workspaceId,
			resourceId: removed.id,
			now: params.now,
			replace: {
				slot: params.slot,
				name: params.selection.name,
				metadata: JSON.stringify(params.selection.metadata),
				requiredScopes: params.requiredScopes,
				providerAccess: params.providerAccess,
			},
		});
	} catch (error) {
		if (isUniqueConstraintError(error)) return undefined;
		throw error;
	}
}

async function createWorkspaceSource(
	context: BaseContext,
	input: {
		workspaceId: string;
		selection: OsWorkspaceResourceSelection;
		slot?: string;
	},
) {
	const workspace = await requireWorkspace(context, input.workspaceId);
	const creator = resolveCreator(context);
	if (
		input.selection.providerId === "tedix" &&
		input.selection.resourceType === "file"
	)
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Use requestFileUpload and confirmFileUpload to attach a workspace file",
		);
	if (
		isWorkspaceLinkResource(input.selection) &&
		!isWorkspaceSkillResource(input.selection)
	)
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Tedis and connections are linked with the skills that use them: link the skill (schedules link), or run link_os_workspace_factory_skills",
		);
	if (
		isWorkspaceSkillResource(input.selection) &&
		(input.selection.connectionScope !== "tenant" ||
			!(await getSkillEntry(
				context.db,
				input.selection.providerResourceId,
				workspace.organizationId,
			)))
	)
		throw createError(
			ErrorCodes.NOT_FOUND,
			"A scheduled skill link needs the id of a skill in this organization and connectionScope tenant",
		);
	const binding = await personalAccountBinding(
		context,
		input.selection.connectionScope,
		input.selection.providerId,
		input.selection.connectionInstanceId,
	);
	const verified = await verifiedResourceScopes(context, input.selection);
	const now = new Date().toISOString();
	const restored = await restoreRemovedTenantResource(context, {
		organizationId: workspace.organizationId,
		workspaceId: workspace.id,
		selection: input.selection,
		slot: input.slot ?? null,
		requiredScopes: JSON.stringify(verified.requiredScopes),
		providerAccess: verified.providerAccess,
		now,
	});
	if (restored)
		return { resource: await projectWorkspaceResource(context, restored) };
	try {
		const row = await createOsWorkspaceResource(queryDb(context), {
			id: crypto.randomUUID(),
			organizationId: workspace.organizationId,
			workspaceId: workspace.id,
			slot: input.slot ?? null,
			providerId: input.selection.providerId,
			connectionScope: input.selection.connectionScope,
			...binding,
			requiredScopes: JSON.stringify(verified.requiredScopes),
			providerAccess: verified.providerAccess,
			resourceType: input.selection.resourceType,
			providerResourceId: input.selection.providerResourceId,
			name: input.selection.name,
			metadata: JSON.stringify(input.selection.metadata),
			status: "active",
			createdByKind: creator.kind,
			createdById: creator.id,
			createdAt: now,
			updatedAt: now,
			removedAt: null,
		});
		return { resource: await projectWorkspaceResource(context, row) };
	} catch (error) {
		if (isUniqueConstraintError(error)) {
			throw createError(
				ErrorCodes.CONFLICT,
				"This provider resource or slot is already attached to the Workspace",
			);
		}
		throw error;
	}
}

const create = authorOs.resources.create.handler(({ input, context }) =>
	createWorkspaceSource(context, input),
);

const availableConnections = readOs.resources.availableConnections.handler(
	async ({ input, context }) => {
		if (context.authType !== "user" || !context.user?.sub || context.tediId)
			throw createError(ErrorCodes.FORBIDDEN, "A signed-in person is required");
		await requireConnectionSender(context, input.workspaceId, context.user.sub);
		return discoverWorkspaceConnections(context);
	},
);

/** The only texts a failed link shows; provider and database errors stay in logs. */
const LINK_FAILURE = {
	unavailable: "This account is unavailable. Check Connections and try again.",
	identityChanged: "The account changed while it was being added. Try again.",
	failed: "This account could not be added. Try again later.",
} as const;

class LinkFailure extends Error {}

const linkConnections = authorOs.resources.linkConnections.handler(
	async ({ input, context }) => {
		if (context.authType !== "user" || !context.user?.sub || context.tediId)
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Only a signed-in person can add these connections",
			);
		const userId = context.user.sub;
		await requireConnectionSender(context, input.workspaceId, userId);
		const available = await discoverWorkspaceConnections(context);
		const linked = await listOsWorkspaceResources(queryDb(context), {
			organizationId: requireOrgId(context),
			workspaceId: input.workspaceId,
			status: "active",
			limit: 1000,
		});
		// One source per account: the account is its provider, scope, owner and
		// named instance (none for the default account), whatever id chose it.
		const accounts = linked
			.filter((row) => row.resourceType === "account")
			.map((row) => ({
				providerId: row.providerId,
				scope: row.connectionScope,
				owner: row.personalOwnerUserId ?? null,
				instanceId: row.connectionInstanceId ?? null,
				providerResourceId: row.providerResourceId,
			}));
		const added: Array<{ id: string; name: string }> = [];
		const failed: Array<{ id: string; message: string }> = [];
		for (const id of new Set(input.connections)) {
			try {
				const connection = available.find((item) => item.id === id);
				if (!connection?.connectedForYou)
					throw new LinkFailure(LINK_FAILURE.unavailable);
				const scope =
					connection.connectionScope === "personal" ? "user" : "tenant";
				const owner = scope === "user" ? userId : null;
				const sameAccount = (instanceId: string | null) =>
					accounts.some(
						(account) =>
							account.providerId === connection.providerId &&
							account.scope === scope &&
							account.owner === owner &&
							(account.providerResourceId === id ||
								account.instanceId === instanceId),
					);
				let instanceId = connection.connectionInstanceId ?? null;
				if (sameAccount(instanceId)) {
					added.push({ id, name: connection.label });
					continue;
				}
				if (scope === "user" && !instanceId) {
					const grant = await adoptDefaultPersonalConnection(context, {
						userId,
						providerId: connection.providerId,
					});
					const instanceOwner = { userId };
					const existing = (
						await listConnectionInstances(context.db, instanceOwner)
					).find(
						(row) =>
							row.providerId === connection.providerId &&
							row.tokenIds.includes(grant.tokenId),
					);
					const instance =
						existing ??
						(await createConnectionInstance(context.db, {
							id: crypto.randomUUID(),
							ownerUserId: userId,
							providerId: connection.providerId,
							label: connection.label,
						}));
					if (
						!existing &&
						!(
							await recordConnectionGrant(context.db, {
								owner: instanceOwner,
								id: instance.id,
								providerId: connection.providerId,
								tokenId: grant.tokenId,
								tokenSub: grant.tokenSub,
							})
						).length
					)
						throw new LinkFailure(LINK_FAILURE.identityChanged);
					instanceId = instance.id;
					// The default login may already be linked as its named account.
					if (sameAccount(instanceId)) {
						added.push({ id, name: connection.label });
						continue;
					}
				}
				await createWorkspaceSource(context, {
					workspaceId: input.workspaceId,
					selection: {
						providerId: connection.providerId,
						connectionScope: scope,
						...(instanceId ? { connectionInstanceId: instanceId } : {}),
						resourceType: "account",
						providerResourceId: id,
						name: connection.label,
						requiredScopes: [],
						metadata: {},
					},
				});
				accounts.push({
					providerId: connection.providerId,
					scope,
					owner,
					instanceId,
					providerResourceId: id,
				});
				added.push({ id, name: connection.label });
			} catch (error) {
				if (!(error instanceof LinkFailure))
					console.error("Workspace connection link failed", {
						workspaceId: input.workspaceId,
						connection: id,
						error,
					});
				failed.push({
					id,
					message:
						error instanceof LinkFailure ? error.message : LINK_FAILURE.failed,
				});
			}
		}
		return { added, failed };
	},
);

const get = readOs.resources.get.handler(async ({ input, context }) => ({
	resource: await projectWorkspaceResource(
		context,
		await requireResource(context, input.workspaceId, input.resourceId),
	),
}));

const listDriveFiles = readOs.resources.listDriveFiles.handler(
	async ({ input, context }) => {
		const authorized = await authorizeWorkspaceResourceRead(context, {
			...input,
			expectedProviderId: "google-drive",
			expectedResourceType: "folder",
		});
		return listWorkspaceDriveFiles(context, { ...input, ...authorized });
	},
);
const readDriveFile = readOs.resources.readDriveFile.handler(
	async ({ input, context }) => {
		const authorized = await authorizeWorkspaceResourceRead(context, {
			...input,
			expectedProviderId: "google-drive",
			expectedResourceType: ["file", "folder"],
		});
		return {
			read: await readWorkspaceDriveFile(context, { ...input, ...authorized }),
		};
	},
);

const readPdf = readOs.resources.readPdf.handler(async ({ input, context }) => {
	const { resource, requiredScopes } = await authorizeWorkspaceResourceRead(
		context,
		{
			workspaceId: input.workspaceId,
			resourceId: input.resourceId,
			expectedProviderId: "google-drive",
			expectedResourceType: "file",
		},
	);
	return {
		pdf: await readWorkspaceDrivePdf(
			context,
			{
				resource,
				requiredScopes,
				pageStart: input.pageStart,
				pageLimit: input.pageLimit,
				charOffset: input.charOffset,
			},
			resource.connectionScope === "user"
				? {
						resolveToken: () =>
							resolveWorkspacePersonalReadCredential(
								context,
								resource,
								requiredScopes,
							),
					}
				: {},
		),
	};
});

const startRepositoryWork = authorOs.resources.startRepositoryWork.handler(
	async ({ input, context }) => {
		const workspace = await requireWorkspace(context, input.workspaceId);
		const resourceRow = await requireResource(
			context,
			input.workspaceId,
			input.resourceId,
		);
		return prepareWorkspaceRepositoryWork(context, {
			input,
			resourceRow,
			resource: mapWorkspaceResource(resourceRow),
			workspace,
		});
	},
);

const rename = authorOs.resources.rename.handler(async ({ input, context }) => {
	const current = await requireResource(
		context,
		input.workspaceId,
		input.resourceId,
	);
	if (current.status !== "active") {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Removed resources cannot be updated",
		);
	}
	let row: OsWorkspaceResourceRow | undefined;
	try {
		row = await renameOsWorkspaceResource(queryDb(context), {
			organizationId: current.organizationId,
			workspaceId: current.workspaceId,
			resourceId: current.id,
			name: input.name,
			slot: input.slot,
			expectedUpdatedAt: input.expectedUpdatedAt,
			now: new Date().toISOString(),
		});
	} catch (error) {
		if (isUniqueConstraintError(error)) {
			throw createError(
				ErrorCodes.CONFLICT,
				"This slot is already attached to the Workspace",
			);
		}
		throw error;
	}
	if (!row) {
		throw createError(
			ErrorCodes.CONFLICT,
			"Workspace resource changed; reload before updating",
		);
	}
	return { resource: await projectWorkspaceResource(context, row) };
});

const rebind = authorOs.resources.rebind.handler(async ({ input, context }) => {
	const workspace = await requireWorkspace(context, input.workspaceId);
	if (workspace.status !== "active") {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Archived Workspaces cannot be rebound",
		);
	}
	const current = await requireResource(
		context,
		input.workspaceId,
		input.resourceId,
	);
	if (current.status !== "active") {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Removed resources cannot be rebound",
		);
	}
	const binding = await personalAccountBinding(
		context,
		input.connectionScope,
		current.providerId,
		input.connectionInstanceId,
	);
	const verifiedScopes = await verifiedResourceScopes(context, {
		providerId: current.providerId,
		resourceType: current.resourceType,
		providerResourceId: current.providerResourceId,
		connectionScope: input.connectionScope,
		connectionInstanceId: input.connectionInstanceId,
		providerAccess: input.providerAccess ?? current.providerAccess,
		requiredScopes:
			input.requiredScopes ?? (JSON.parse(current.requiredScopes) as string[]),
	});
	const previousUpdatedAt = Date.parse(current.updatedAt);
	const now = new Date(
		Math.max(
			Date.now(),
			Number.isFinite(previousUpdatedAt) ? previousUpdatedAt + 1 : 0,
		),
	).toISOString();
	let row: OsWorkspaceResourceRow | undefined;
	try {
		row = await rebindOsWorkspaceResource(queryDb(context), {
			organizationId: current.organizationId,
			workspaceId: current.workspaceId,
			resourceId: current.id,
			connectionScope: input.connectionScope,
			...binding,
			requiredScopes: JSON.stringify(verifiedScopes.requiredScopes),
			providerAccess: verifiedScopes.providerAccess,
			expectedUpdatedAt: input.expectedUpdatedAt,
			now,
		});
	} catch (error) {
		if (isUniqueConstraintError(error)) {
			throw createError(
				ErrorCodes.CONFLICT,
				"This provider object is already bound in the Workspace for that connection scope",
			);
		}
		throw error;
	}
	if (!row) {
		throw createError(
			ErrorCodes.CONFLICT,
			"Workspace resource changed; reload before rebinding",
		);
	}
	return { resource: await projectWorkspaceResource(context, row) };
});

const remove = authorOs.resources.remove.handler(async ({ input, context }) => {
	const current = await requireResource(
		context,
		input.workspaceId,
		input.resourceId,
	);
	if (current.status !== "active") {
		return { resource: await projectWorkspaceResource(context, current) };
	}
	const row = await removeOsWorkspaceResource(queryDb(context), {
		organizationId: current.organizationId,
		workspaceId: current.workspaceId,
		resourceId: current.id,
		expectedUpdatedAt: input.expectedUpdatedAt,
		now: new Date().toISOString(),
	});
	if (!row) {
		throw createError(
			ErrorCodes.CONFLICT,
			"Workspace resource changed; reload before removing",
		);
	}
	return { resource: await projectWorkspaceResource(context, row) };
});

export const osWorkspaceResourceProcedures = {
	availableConnections,
	linkConnections,
	list,
	create,
	get,
	readPdf,
	listDriveFiles,
	readDriveFile,
	startRepositoryWork,
	rebind,
	rename,
	remove,
};
