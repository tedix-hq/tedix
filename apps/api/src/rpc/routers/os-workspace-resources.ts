import { implement } from "@orpc/server";
import { osWorkspacesContract } from "@tedix/api-contract/contracts/os-workspaces";
import {
	type OsWorkspaceResource,
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
import { authorizeWorkspaceResourceRead } from "../../services/os-workspace-resource-read-authority";
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
	const now = new Date().toISOString();
	try {
		const row = await createOsWorkspaceResource(queryDb(context), {
			id: crypto.randomUUID(),
			organizationId: workspace.organizationId,
			workspaceId: workspace.id,
			slot: null,
			providerId: input.selection.providerId,
			connectionScope: input.selection.connectionScope,
			requiredScopes: JSON.stringify(input.selection.requiredScopes),
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
		pdf: await readWorkspaceDrivePdf(context, {
			resource,
			requiredScopes,
			pageStart: input.pageStart,
			pageLimit: input.pageLimit,
			charOffset: input.charOffset,
		}),
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
			...(input.requiredScopes === undefined
				? {}
				: { requiredScopes: JSON.stringify(input.requiredScopes) }),
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
