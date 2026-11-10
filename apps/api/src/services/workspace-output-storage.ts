import { env, waitUntil } from "cloudflare:workers";
import * as legacy from "@tedix/db/queries/os-workspaces/outputs";
import type {
	OutputTransferResult,
	WorkspaceOutputRuntime,
} from "@tedix/db/queries/durable-sqlite/output-rpc";
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

/** An indexed workspace output is read only from its owning object. */
export async function getOsOutput(
	...args: Parameters<typeof legacy.getOsOutput>
) {
	const store = runtime();
	const scope = store
		? await location(args[0], args[1].organizationId, args[1].outputId)
		: undefined;
	if (!scope) return legacy.getOsOutput(...args);
	if (args[1].workspaceId && scope.workspaceId !== args[1].workspaceId)
		return undefined;
	return store!.outputQuery(scope, { op: "get", outputId: args[1].outputId });
}

export async function moveOsOutput(
	db: DbQueryClient,
	output: NonNullable<Awaited<ReturnType<typeof getOsOutput>>>,
	targetWorkspaceId: string,
): Promise<OutputTransferResult> {
	const store = runtime();
	if (!store) {
		const moved = await legacy.updateOsOutput(
			db,
			{ organizationId: output.organizationId, outputId: output.id },
			{ workspaceId: targetWorkspaceId },
		);
		return moved
			? { ok: true, output: moved }
			: { ok: false, reason: "not_found" };
	}
	if (!output.workspaceId) return { ok: false, reason: "not_found" };
	return store.transferOutput(
		{ organizationId: output.organizationId, workspaceId: output.workspaceId },
		output.id,
		targetWorkspaceId,
	);
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
		// Repair projections a failed write may have left stale, after the
		// response: awaiting one refresh per file made every list cost seconds.
		const workspaceScope = {
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
		};
		const repairs = objectRows
			.filter((row) => !rows.some((candidate) => candidate.id === row.id))
			.map((row) => refreshCommittedOutput(store, workspaceScope, row.id));
		if (repairs.length) waitUntil(Promise.all(repairs));
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
	if (!runtime()) return legacy.getOsOutputRevision(...args);
	const index = await getWorkspaceOutputIndexRevision(args[0], args[1]);
	return index
		? runtime()!.outputQuery(
				{
					organizationId: index.organizationId,
					workspaceId: index.workspaceId,
				},
				{ op: "revision", revisionId: args[1].revisionId },
			)
		: legacy.getOsOutputRevision(...args);
}

export async function getOsOutputRevisionByNumber(
	...args: Parameters<typeof legacy.getOsOutputRevisionByNumber>
) {
	const scope = runtime()
		? await location(args[0], args[1].organizationId, args[1].outputId)
		: undefined;
	return scope
		? runtime()!.outputQuery(scope, {
				op: "revisionByNumber",
				outputId: args[1].outputId,
				revision: args[1].revision,
			})
		: legacy.getOsOutputRevisionByNumber(...args);
}

export async function listOsOutputRevisions(
	...args: Parameters<typeof legacy.listOsOutputRevisions>
) {
	const scope = runtime()
		? await location(args[0], args[1].organizationId, args[1].outputId)
		: undefined;
	return scope
		? runtime()!.outputQuery(scope, {
				op: "history",
				outputId: args[1].outputId,
				options: args[2],
			})
		: legacy.listOsOutputRevisions(...args);
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
	const scope = runtime()
		? await location(db, params.organizationId, params.outputId)
		: undefined;
	if (!scope) return legacy.createOsOutputRevision(...args);
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
	const scope = runtime()
		? await location(args[0], args[1].organizationId, args[1].outputId)
		: undefined;
	return scope
		? runtime()!.outputQuery(scope, {
				op: "update",
				outputId: args[1].outputId,
				patch: args[2],
			})
		: legacy.updateOsOutput(...args);
}

export async function getActiveSheetByTitle(
	...args: Parameters<typeof legacy.getActiveSheetByTitle>
) {
	const existing = await legacy.getActiveSheetByTitle(...args);
	if (!runtime()) return existing;
	const object = await runtime()!.outputQuery(
		{
			organizationId: args[1].organizationId,
			workspaceId: args[1].workspaceId,
		},
		{ op: "activeSheet", title: args[1].title },
	);
	if (!object || object.output.id === existing?.output.id) return existing;
	return !existing ||
		object.output.updatedAt > existing.output.updatedAt ||
		(object.output.updatedAt === existing.output.updatedAt &&
			object.output.id > existing.output.id)
		? object
		: existing;
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
		if (removed && existing.workspaceId && runtime()) {
			await refreshCommittedOutput(
				runtime()!,
				{
					organizationId: existing.organizationId,
					workspaceId: existing.workspaceId,
				},
				existing.id,
			);
		}
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
