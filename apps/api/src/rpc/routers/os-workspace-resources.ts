import { personalResourceScopesCover } from "@tedix/api-contract/utils/personal-resource-tool-binding";
import { fetchNamedConnection } from "./connections/policy-resolution";
import {
	supportedCalendarAccounts,
	calendarOwnerUser,
	resolveCalendarAdapter,
} from "../../services/calendar-coordinator/credentials";
import { getConnectionInstance } from "@tedix/db/queries/connection-instances";
import { implement } from "@orpc/server";
import { osWorkspacesContract } from "@tedix/api-contract/contracts/os-workspaces";
import {
	type OsWorkspaceResource,
	type OsWorkspaceResourceSelection,
	OsWorkspaceResourceSchema,
} from "@tedix/api-contract/schemas/os-workspaces";
import {
	createOsWorkspaceResource,
	getOsWorkspaceResource,
	listOsWorkspaceResources,
	removeOsWorkspaceResource,
	rebindOsWorkspaceResource,
	renameOsWorkspaceResource,
} from "@tedix/db/queries/os-workspaces/resources";
import { createDbQueryClient } from "@tedix/db/query-client";
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
	return createDbQueryClient(context.env.DB);
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
	return OsWorkspaceResourceSchema.parse({
		...resource,
		availability: await resolveWorkspaceResourceAvailability(context, resource),
	});
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
	return row;
}

async function personalAccountBinding(
	context: BaseContext,
	scope: "tenant" | "user",
	providerId: string,
	instanceId?: string,
) {
	if (scope === "tenant")
		return { personalOwnerUserId: null, connectionInstanceId: null };
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
	},
) {
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
	const requiredScopes =
		account.adapter === "google"
			? observed.filter((scope) =>
					[
						"https://www.googleapis.com/auth/calendar",
						"https://www.googleapis.com/auth/calendar.readonly",
						"https://www.googleapis.com/auth/calendar.events",
						"https://www.googleapis.com/auth/calendar.events.readonly",
						"https://www.googleapis.com/auth/calendar.calendarlist.readonly",
					].includes(scope),
				)
			: observed.filter((scope) =>
					/(^|\/)Calendars\.(Read|ReadWrite)$/i.test(scope),
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

const create = authorOs.resources.create.handler(async ({ input, context }) => {
	const workspace = await requireWorkspace(context, input.workspaceId);
	const creator = resolveCreator(context);
	const binding = await personalAccountBinding(
		context,
		input.selection.connectionScope,
		input.selection.providerId,
		input.selection.connectionInstanceId,
	);
	const verified = await verifiedResourceScopes(context, input.selection);
	const now = new Date().toISOString();
	try {
		const row = await createOsWorkspaceResource(queryDb(context), {
			id: crypto.randomUUID(),
			organizationId: workspace.organizationId,
			workspaceId: workspace.id,
			slot: null,
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
				"This provider resource is already attached to the Workspace",
			);
		}
		throw error;
	}
});

const get = readOs.resources.get.handler(async ({ input, context }) => ({
	resource: await projectWorkspaceResource(
		context,
		await requireResource(context, input.workspaceId, input.resourceId),
	),
}));

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
			"Removed resources cannot be renamed",
		);
	}
	const row = await renameOsWorkspaceResource(queryDb(context), {
		organizationId: current.organizationId,
		workspaceId: current.workspaceId,
		resourceId: current.id,
		name: input.name,
		expectedUpdatedAt: input.expectedUpdatedAt,
		now: new Date().toISOString(),
	});
	if (!row) {
		throw createError(
			ErrorCodes.CONFLICT,
			"Workspace resource changed; reload before renaming",
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
	list,
	create,
	get,
	readPdf,
	startRepositoryWork,
	rebind,
	rename,
	remove,
};
