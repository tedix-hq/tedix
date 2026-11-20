import * as apps from "@tedix/db/queries/os-workspaces/install-app";
import { getOsGadget } from "@tedix/db/queries/os-workspaces/gadgets";
import type { DbQueryClient } from "@tedix/db/query-client";
import * as resources from "@tedix/db/queries/os-workspaces/resources";
import type { OutputQueryInputs } from "@tedix/db/queries/durable-sqlite/output-rpc";
import {
	workspaceDocumentRuntime,
	workspaceOwnsDocuments,
} from "./workspace-document-owner";

type ResourceQuery = OutputQueryInputs["resources"]["query"];

async function objectQuery(
	db: DbQueryClient,
	query: ResourceQuery,
	write: boolean,
) {
	const scope = {
		organizationId: query.params.organizationId,
		workspaceId: query.params.workspaceId,
	};
	if (!(await workspaceOwnsDocuments(scope))) return { owned: false as const };
	const row = await workspaceDocumentRuntime().outputQuery(scope, {
		op: "resources",
		query,
	});
	if (write && row) await resources.projectOsWorkspaceResource(db, row);
	return { owned: true as const, row };
}

export async function createOsWorkspaceResource(
	db: DbQueryClient,
	params: Parameters<typeof resources.createOsWorkspaceResource>[1],
) {
	const result = await objectQuery(db, { operation: "create", params }, true);
	if (!result.owned) return resources.createOsWorkspaceResource(db, params);
	if (!result.row) throw new Error("Workspace resource insert returned no row");
	return result.row;
}

export async function getOsWorkspaceResource(
	db: DbQueryClient,
	params: Parameters<typeof resources.getOsWorkspaceResource>[1],
) {
	const result = await objectQuery(db, { operation: "get", params }, false);
	if (!result.owned) return resources.getOsWorkspaceResource(db, params);
	return result.row;
}

export async function findOsWorkspaceTenantResource(
	db: DbQueryClient,
	params: Parameters<typeof resources.findOsWorkspaceTenantResource>[1],
) {
	const result = await objectQuery(db, { operation: "find", params }, false);
	if (!result.owned) return resources.findOsWorkspaceTenantResource(db, params);
	return result.row;
}

export async function renameOsWorkspaceResource(
	db: DbQueryClient,
	params: Parameters<typeof resources.renameOsWorkspaceResource>[1],
) {
	const result = await objectQuery(db, { operation: "rename", params }, true);
	if (!result.owned) return resources.renameOsWorkspaceResource(db, params);
	return result.row;
}

export async function rebindOsWorkspaceResource(
	db: DbQueryClient,
	params: Parameters<typeof resources.rebindOsWorkspaceResource>[1],
) {
	const result = await objectQuery(db, { operation: "rebind", params }, true);
	if (!result.owned) return resources.rebindOsWorkspaceResource(db, params);
	return result.row;
}

export async function removeOsWorkspaceResource(
	db: DbQueryClient,
	params: Parameters<typeof resources.removeOsWorkspaceResource>[1],
) {
	const result = await objectQuery(db, { operation: "remove", params }, true);
	if (!result.owned) return resources.removeOsWorkspaceResource(db, params);
	return result.row;
}

export async function restoreOsWorkspaceResource(
	db: DbQueryClient,
	params: Parameters<typeof resources.restoreOsWorkspaceResource>[1],
) {
	const result = await objectQuery(db, { operation: "restore", params }, true);
	if (!result.owned) return resources.restoreOsWorkspaceResource(db, params);
	return result.row;
}

export async function updateOsWorkspaceResourceMetadata(
	db: DbQueryClient,
	params: Parameters<typeof resources.updateOsWorkspaceResourceMetadata>[1],
) {
	const result = await objectQuery(db, { operation: "metadata", params }, true);
	if (!result.owned)
		return resources.updateOsWorkspaceResourceMetadata(db, params);
	return result.row;
}

/** Upload confirmation is idempotent; bytes have already been verified by the caller. */
/**
 * Saves an uploaded file's row in the workspace store, then its shared copy
 * for list screens. Once the store holds the file, a busy main database must
 * not fail the upload: the person would retry and save a second copy. The
 * shared copy is then left to `retryResourceProjection`.
 */
export async function confirmWorkspaceFileResource(
	db: DbQueryClient,
	resource: Parameters<typeof resources.createOsWorkspaceResource>[1],
) {
	const result = await objectQuery(
		db,
		{ operation: "ensure", params: resource },
		false,
	);
	if (!result.owned) {
		await resources.ensureOsWorkspaceResource(db, resource);
		return { pendingProjection: undefined };
	}
	if (!result.row) throw new Error("Workspace resource insert returned no row");
	return {
		pendingProjection: (await projectResource(db, result.row))
			? undefined
			: result.row,
	};
}

type ResourceRow = Parameters<typeof resources.projectOsWorkspaceResource>[1];

/** Writes the shared copy; false when the main database refused it. */
async function projectResource(db: DbQueryClient, row: ResourceRow) {
	try {
		await resources.projectOsWorkspaceResource(db, row);
		return true;
	} catch (error) {
		console.warn("workspace_resource_projection_pending", {
			resourceId: row.id,
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}

/** Retries a shared copy the main database refused, after the response. */
export async function retryResourceProjection(
	db: DbQueryClient,
	row: ResourceRow,
) {
	for (const delayMs of [2_000, 8_000]) {
		await new Promise((resolve) => setTimeout(resolve, delayMs));
		if (await projectResource(db, row)) return;
	}
}

/** Repairs a missing shared copy when the same upload is confirmed again. */
export async function ensureResourceProjection(
	db: DbQueryClient,
	row: ResourceRow,
) {
	const projected = await resources
		.getOsWorkspaceResource(db, {
			organizationId: row.organizationId,
			workspaceId: row.workspaceId,
			resourceId: row.id,
		})
		.catch(() => null);
	if (!projected) await projectResource(db, row);
}

export async function findWorkspaceOutputResource(
	db: DbQueryClient,
	scope: Parameters<typeof apps.findWorkspaceOutputResource>[1],
) {
	if (!(await workspaceOwnsDocuments(scope)))
		return apps.findWorkspaceOutputResource(db, scope);
	return findOsWorkspaceTenantResource(db, {
		...scope,
		providerId: "tedix",
		resourceType: "output",
		providerResourceId: scope.outputId,
	});
}

export async function installWorkspaceApp(
	db: DbQueryClient,
	params: Parameters<typeof apps.installWorkspaceApp>[1],
) {
	const scope = {
		organizationId: params.gadget.organizationId,
		workspaceId: params.gadget.workspaceId,
	};
	if (params.resource && (await workspaceOwnsDocuments(scope))) {
		await workspaceDocumentRuntime().outputQuery(scope, {
			op: "resources",
			query: { operation: "ensure", params: params.resource },
		});
	}
	return apps.installWorkspaceApp(db, params);
}

export async function linkWorkspaceOutputEditor(
	db: DbQueryClient,
	params: Parameters<typeof apps.linkWorkspaceOutputEditor>[1],
) {
	if (!(await workspaceOwnsDocuments(params)))
		return apps.linkWorkspaceOutputEditor(db, params);
	const gadget = await getOsGadget(db, {
		organizationId: params.organizationId,
		gadgetId: params.gadgetId,
	});
	if (
		!gadget ||
		gadget.workspaceId !== params.workspaceId ||
		gadget.currentRevisionId !== params.expectedGadgetRevisionId ||
		gadget.status !== "active"
	)
		return undefined;
	const resource = await getOsWorkspaceResource(db, params);
	if (
		!resource ||
		resource.providerId !== "tedix" ||
		resource.resourceType !== "output" ||
		resource.providerResourceId !== params.outputId ||
		resource.slot !== params.expectedSlot ||
		resource.connectionScope !== "tenant" ||
		resource.status !== "active"
	)
		return undefined;
	const row = await updateOsWorkspaceResourceMetadata(db, {
		...params,
		metadata: JSON.stringify({
			...JSON.parse(resource.metadata),
			gadgetId: params.gadgetId,
			kind: params.kind,
		}),
		expectedUpdatedAt: resource.updatedAt,
	});
	return row ? { id: row.id } : undefined;
}
