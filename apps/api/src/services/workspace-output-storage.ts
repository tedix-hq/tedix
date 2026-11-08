import { env } from "cloudflare:workers";
import * as legacy from "@tedix/db/queries/os-workspaces/outputs";
import type { WorkspaceOutputRuntime } from "@tedix/db/queries/durable-sqlite/output-rpc";
import {
	getWorkspaceOutputIndexCurrent,
	getWorkspaceOutputIndexRevision,
	listWorkspaceOutputLibrary,
} from "@tedix/db/queries/workspace-feed/read";
import type { DbQueryClient } from "@tedix/db/query-client";
import {
	getOsWorkspace,
	isOsWorkspaceVisibleTo,
	type OsWorkspaceScopeParams,
} from "@tedix/db/queries/os-workspaces/workspaces";
import { outputLibraryRowsFromIndex } from "./os-output-library";

async function refreshCommittedOutput(
	store: WorkspaceOutputRuntime,
	scope: OsWorkspaceScopeParams,
	outputId: string,
) {
	try {
		await store.refreshOutputProjection(scope, outputId);
	} catch (error) {
		console.warn("workspace_output_projection_pending", {
			outputId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

function runtime(): WorkspaceOutputRuntime | undefined {
	return (env as unknown as { WORKSPACE_RUNTIME?: WorkspaceOutputRuntime })
		.WORKSPACE_RUNTIME;
}

async function location(
	db: DbQueryClient,
	organizationId: string,
	outputId: string,
) {
	const index = await getWorkspaceOutputIndexCurrent(db, {
		organizationId,
		outputId,
	});
	return index ? { organizationId, workspaceId: index.workspaceId } : undefined;
}

/** Existing D1 IDs retain their authority; newly created workspace IDs belong to the object. */
export async function getOsOutput(
	...args: Parameters<typeof legacy.getOsOutput>
) {
	const row = await legacy.getOsOutput(...args);
	if (row || !runtime()) return row;
	const scope = await location(
		args[0],
		args[1].organizationId,
		args[1].outputId,
	);
	if (scope && args[1].workspaceId && scope.workspaceId !== args[1].workspaceId)
		return undefined;
	return scope
		? runtime()!.outputQuery(scope, { op: "get", outputId: args[1].outputId })
		: undefined;
}

export async function listOsOutputs(
	...args: Parameters<typeof legacy.listOsOutputs>
) {
	const [db, scope, viewer, options = {}] = args;
	const rows = await legacy.listOsOutputs(...args);
	const store = runtime();
	if (!store) return rows;
	let objectRows;
	if (scope.workspaceId) {
		const workspace = await getOsWorkspace(db, {
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
		});
		if (!workspace || !isOsWorkspaceVisibleTo(workspace, viewer)) return rows;
		objectRows = await store.outputQuery(
			{ organizationId: scope.organizationId, workspaceId: scope.workspaceId },
			{ op: "list", options },
		);
		for (const row of objectRows) {
			if (rows.some((candidate) => candidate.id === row.id)) continue;
			await store.refreshOutputProjection(
				{
					organizationId: scope.organizationId,
					workspaceId: scope.workspaceId,
				},
				row.id,
			);
		}
	} else {
		const indexed = await listWorkspaceOutputLibrary(
			db,
			{ organizationId: scope.organizationId, viewer },
			options,
		);
		objectRows = indexed.map((row) => outputLibraryRowsFromIndex(row).output);
	}
	const merged = new Map(objectRows.map((row) => [row.id, row]));
	for (const row of rows) merged.set(row.id, row);
	return [...merged.values()]
		.sort(
			(a, b) =>
				b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id),
		)
		.slice(0, options.limit ?? 100);
}

export async function getOsOutputRevision(
	...args: Parameters<typeof legacy.getOsOutputRevision>
) {
	const row = await legacy.getOsOutputRevision(...args);
	if (row || !runtime()) return row;
	const index = await getWorkspaceOutputIndexRevision(args[0], args[1]);
	return index
		? runtime()!.outputQuery(
				{
					organizationId: index.organizationId,
					workspaceId: index.workspaceId,
				},
				{ op: "revision", revisionId: args[1].revisionId },
			)
		: undefined;
}

export async function getOsOutputRevisionByNumber(
	...args: Parameters<typeof legacy.getOsOutputRevisionByNumber>
) {
	if (await legacy.getOsOutput(args[0], args[1]))
		return legacy.getOsOutputRevisionByNumber(...args);
	const scope = runtime()
		? await location(args[0], args[1].organizationId, args[1].outputId)
		: undefined;
	return scope
		? runtime()!.outputQuery(scope, {
				op: "revisionByNumber",
				outputId: args[1].outputId,
				revision: args[1].revision,
			})
		: undefined;
}

export async function listOsOutputRevisions(
	...args: Parameters<typeof legacy.listOsOutputRevisions>
) {
	if (await legacy.getOsOutput(args[0], args[1]))
		return legacy.listOsOutputRevisions(...args);
	const scope = runtime()
		? await location(args[0], args[1].organizationId, args[1].outputId)
		: undefined;
	return scope
		? runtime()!.outputQuery(scope, {
				op: "history",
				outputId: args[1].outputId,
				options: args[2],
			})
		: [];
}

export async function createOsOutput(
	...args: Parameters<typeof legacy.createOsOutput>
) {
	const [, scope, output, revision] = args;
	if (!output.workspaceId || !runtime()) return legacy.createOsOutput(...args);
	const created = await runtime()!.outputQuery(
		{ organizationId: scope.organizationId, workspaceId: output.workspaceId },
		{ op: "create", output, revision },
	);
	await refreshCommittedOutput(
		runtime()!,
		{ organizationId: scope.organizationId, workspaceId: output.workspaceId },
		output.id,
	);
	return created;
}

export async function createOsOutputRevision(
	...args: Parameters<typeof legacy.createOsOutputRevision>
) {
	const [db, params] = args;
	if (await legacy.getOsOutput(db, params))
		return legacy.createOsOutputRevision(...args);
	const scope = runtime()
		? await location(db, params.organizationId, params.outputId)
		: undefined;
	if (!scope)
		return { ok: false as const, reason: "output_not_found" as const };
	if (!params.bodyR2Key || !params.contentSha256 || params.contentBytes == null)
		throw new Error("Workspace output revision requires its stored R2 body");
	const result = await runtime()!.outputQuery(scope, {
		op: "revise",
		params: {
			...params,
			bodyR2Key: params.bodyR2Key,
			contentSha256: params.contentSha256,
			contentBytes: params.contentBytes,
		},
	});
	if (result.ok)
		await refreshCommittedOutput(runtime()!, scope, params.outputId);
	return result;
}

export async function updateOsOutput(
	...args: Parameters<typeof legacy.updateOsOutput>
) {
	if (await legacy.getOsOutput(args[0], args[1]))
		return legacy.updateOsOutput(...args);
	const scope = runtime()
		? await location(args[0], args[1].organizationId, args[1].outputId)
		: undefined;
	return scope
		? runtime()!.outputQuery(scope, {
				op: "update",
				outputId: args[1].outputId,
				patch: args[2],
			})
		: undefined;
}

export async function getActiveSheetByTitle(
	...args: Parameters<typeof legacy.getActiveSheetByTitle>
) {
	const existing = await legacy.getActiveSheetByTitle(...args);
	if (existing || !runtime()) return existing;
	return runtime()!.outputQuery(
		{
			organizationId: args[1].organizationId,
			workspaceId: args[1].workspaceId,
		},
		{ op: "activeSheet", title: args[1].title },
	);
}

export async function deleteOsOutput(
	...args: Parameters<typeof legacy.deleteOsOutput>
) {
	const [db, params] = args;
	const existing = await legacy.getOsOutput(db, params);
	if (existing) {
		if (existing.workspaceId && runtime()) {
			const scope = {
				organizationId: existing.organizationId,
				workspaceId: existing.workspaceId,
			};
			await runtime()!.outputQuery(scope, {
				op: "delete",
				outputId: existing.id,
			});
		}
		const removed = await legacy.deleteOsOutput(...args);
		return removed;
	}
	const scope = runtime()
		? await location(db, params.organizationId, params.outputId)
		: undefined;
	if (!scope) return false;
	const removed = await runtime()!.outputQuery(scope, {
		op: "delete",
		outputId: params.outputId,
	});
	return removed;
}
