import type { CommitCollaborationOutputParams } from "@tedix/db/queries/os-workspaces/collaboration";
import { env, waitUntil } from "cloudflare:workers";
import type { TenantScope } from "@tedix/db/tenant-scope";
import type {
	NewOsOutputRow,
	NewOsOutputRevisionRow,
} from "@tedix/db/schema/os-workspaces";
import type {
	ListOsOutputsOptions,
	UpdateOsOutputPatch,
	CreateOsOutputRevisionParams as ObjectRevisionParams,
} from "@tedix/db/queries/durable-sqlite/os-outputs";
import type {
	OutputTransferResult,
	WorkspaceOutputRuntime,
} from "@tedix/db/queries/durable-sqlite/output-rpc";
import {
	getWorkspaceOutputLocation,
	getWorkspaceOutputIndexRevision,
	listWorkspaceOutputLibrary,
} from "@tedix/db/queries/workspace-feed/read";
import type { DbQueryClient } from "@tedix/db/query-client";
import {
	getOsWorkspace,
	isOsWorkspaceVisibleTo,
	type OsWorkspaceScopeParams,
	type OsWorkspaceViewer,
} from "@tedix/db/queries/os-workspaces/workspaces";
import { outputLibraryRowsFromIndex } from "./os-output-library";
import { deleteOutputAssets } from "./os-output-assets";
import { workspaceOwnsDocuments } from "./workspace-document-owner";

type OutputScope = TenantScope & { outputId: string };
type CreateOutputArgs = [
	db: DbQueryClient,
	scope: TenantScope,
	output: NewOsOutputRow,
	revision: NewOsOutputRevisionRow,
	/** Searchable text of the body; the workspace publishes it with the save. */
	excerpt?: string,
];
type RevisionParams = Omit<
	ObjectRevisionParams,
	"bodyR2Key" | "contentSha256" | "contentBytes"
> &
	Pick<
		NewOsOutputRevisionRow,
		"content" | "bodyR2Key" | "contentSha256" | "contentBytes"
	> &
	TenantScope & { expectedWorkspaceId?: string };

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
	const scope = await readLocation(db, organizationId, outputId);
	if (!scope) return undefined;
	return (await workspaceOwnsDocuments(scope, runtime()!)) ? scope : undefined;
}

function readRuntime(): WorkspaceOutputRuntime {
	const store = runtime();
	if (!store) throw new Error("Workspace output runtime is unavailable");
	return store;
}

async function readLocation(
	db: DbQueryClient,
	organizationId: string,
	outputId: string,
) {
	const index = await getWorkspaceOutputLocation(db, {
		organizationId,
		outputId,
	});
	return index?.workspaceId
		? { organizationId, workspaceId: index.workspaceId }
		: undefined;
}

export async function getOsOutput(
	...args: [db: DbQueryClient, params: OutputScope]
) {
	const store = readRuntime();
	const scope = await readLocation(
		args[0],
		args[1].organizationId,
		args[1].outputId,
	);
	if (!scope) return undefined;
	if (args[1].workspaceId && scope.workspaceId !== args[1].workspaceId)
		return undefined;
	return store.outputQuery(scope, { op: "get", outputId: args[1].outputId });
}

/**
 * Why a file was not moved. The store answers `not_found` and `conflict` (a
 * move of this file is in progress); the two `not_ready` reasons are decided
 * here, before the store is asked to start anything.
 */
export type MoveOsOutputResult =
	| OutputTransferResult
	| { ok: false; reason: "source_not_ready" | "target_not_ready" };

export async function moveOsOutput(
	_db: DbQueryClient,
	output: NonNullable<Awaited<ReturnType<typeof getOsOutput>>>,
	targetWorkspaceId: string,
): Promise<MoveOsOutputResult> {
	const store = readRuntime();
	const { organizationId, workspaceId } = output;
	if (
		!workspaceId ||
		!(await workspaceOwnsDocuments({ organizationId, workspaceId }, store))
	)
		return { ok: false, reason: "source_not_ready" };
	// A store that does not keep its own files yet cannot take one. Asking
	// first keeps the file from waiting on a move that cannot finish.
	if (
		!(await workspaceOwnsDocuments(
			{ organizationId, workspaceId: targetWorkspaceId },
			store,
		))
	)
		return { ok: false, reason: "target_not_ready" };
	return store.transferOutput(
		{ organizationId, workspaceId },
		output.id,
		targetWorkspaceId,
	);
}

export async function listOsOutputs(
	...args: [
		db: DbQueryClient,
		scope: TenantScope,
		viewer: OsWorkspaceViewer,
		options?: ListOsOutputsOptions,
	]
) {
	const [db, scope, viewer, options = {}] = args;
	let objectRows;
	if (scope.workspaceId) {
		const workspace = await getOsWorkspace(db, {
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
		});
		if (!workspace || !isOsWorkspaceVisibleTo(workspace, viewer)) return [];
		const store = readRuntime();
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
		const repairs = objectRows.map((row) =>
			refreshCommittedOutput(store, workspaceScope, row.id),
		);
		if (repairs.length) waitUntil(Promise.all(repairs));
	} else {
		const indexed = await listWorkspaceOutputLibrary(
			db,
			{ organizationId: scope.organizationId, viewer },
			options,
		);
		objectRows = indexed.map((row) => outputLibraryRowsFromIndex(row).output);
	}
	return objectRows
		.sort(
			(a, b) =>
				b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id),
		)
		.slice(0, options.limit ?? 100);
}

export async function getOsOutputRevision(
	...args: [db: DbQueryClient, params: TenantScope & { revisionId: string }]
) {
	const store = readRuntime();
	const index = await getWorkspaceOutputIndexRevision(args[0], args[1]);
	return index
		? store.outputQuery(
				{
					organizationId: index.organizationId,
					workspaceId: index.workspaceId,
				},
				{ op: "revision", revisionId: args[1].revisionId },
			)
		: undefined;
}

export async function getOsOutputRevisionByNumber(
	...args: [db: DbQueryClient, params: OutputScope & { revision: number }]
) {
	const store = readRuntime();
	const scope = await readLocation(
		args[0],
		args[1].organizationId,
		args[1].outputId,
	);
	return scope
		? store.outputQuery(scope, {
				op: "revisionByNumber",
				outputId: args[1].outputId,
				revision: args[1].revision,
			})
		: undefined;
}

export async function listOsOutputRevisions(
	...args: [
		db: DbQueryClient,
		params: OutputScope,
		options?: { limit?: number; beforeRevision?: number },
	]
) {
	const store = readRuntime();
	const scope = await readLocation(
		args[0],
		args[1].organizationId,
		args[1].outputId,
	);
	return scope
		? store.outputQuery(scope, {
				op: "history",
				outputId: args[1].outputId,
				options: args[2],
			})
		: [];
}

export async function requireWorkspaceOutputAuthority(scope: {
	organizationId: string;
	workspaceId?: string | null;
}) {
	const store = readRuntime();
	if (
		!scope.workspaceId ||
		!(await workspaceOwnsDocuments(
			{ organizationId: scope.organizationId, workspaceId: scope.workspaceId },
			store,
		))
	)
		throw new Error(
			"Workspace output writes require an activated workspace object",
		);
	return {
		organizationId: scope.organizationId,
		workspaceId: scope.workspaceId,
	};
}

export async function createOsOutput(...args: CreateOutputArgs) {
	const [, scope, output, revision, excerpt] = args;
	const store = readRuntime();
	const bound = await requireWorkspaceOutputAuthority({
		organizationId: scope.organizationId,
		workspaceId: output.workspaceId,
	});
	const created = await store.outputQuery(bound, {
		op: "create",
		output,
		revision,
		...(excerpt ? { excerpt } : {}),
	});
	await refreshCommittedOutput(store, bound, output.id);
	return created;
}

/** Concurrent upload confirmations must preserve the document and any later edits. */
export async function ensureOsOutput(...args: CreateOutputArgs) {
	const [, scope, output] = args;
	const bound = await requireWorkspaceOutputAuthority({
		organizationId: scope.organizationId,
		workspaceId: output.workspaceId,
	});
	const store = readRuntime();
	const existing = () =>
		store.outputQuery(bound, { op: "get", outputId: output.id });
	if (!(await existing())) {
		try {
			await createOsOutput(...args);
		} catch (error) {
			// The object serializes inserts; another confirmation may have won.
			if (!(await existing())) throw error;
		}
	}
	await refreshCommittedOutput(store, bound, output.id);
}

export async function createOsOutputRevision(
	...args: [db: DbQueryClient, params: RevisionParams, excerpt?: string]
) {
	const [db, params, excerpt] = args;
	const store = readRuntime();
	const scope = await location(db, params.organizationId, params.outputId);
	if (!scope)
		throw new Error(
			"Workspace output writes require an activated workspace object",
		);
	if (!params.bodyR2Key || !params.contentSha256 || params.contentBytes == null)
		throw new Error("Workspace output revision requires its stored R2 body");
	const result = await store.outputQuery(scope, {
		op: "revise",
		params: {
			...params,
			bodyR2Key: params.bodyR2Key,
			contentSha256: params.contentSha256,
			contentBytes: params.contentBytes,
		},
		...(excerpt ? { excerpt } : {}),
	});
	if (result.ok) await refreshCommittedOutput(store, scope, params.outputId);
	return result;
}

export async function updateOsOutput(
	...args: [db: DbQueryClient, params: OutputScope, patch: UpdateOsOutputPatch]
) {
	const store = readRuntime();
	const scope = await location(
		args[0],
		args[1].organizationId,
		args[1].outputId,
	);
	if (!scope)
		throw new Error(
			"Workspace output writes require an activated workspace object",
		);
	return store.outputQuery(scope, {
		op: "update",
		outputId: args[1].outputId,
		patch: args[2],
	});
}

export async function getActiveSheetByTitle(
	...args: [
		db: DbQueryClient,
		params: OsWorkspaceScopeParams & { title: string },
	]
) {
	return readRuntime().outputQuery(
		{
			organizationId: args[1].organizationId,
			workspaceId: args[1].workspaceId,
		},
		{ op: "activeSheet", title: args[1].title },
	);
}

export async function deleteOsOutput(
	...args: [db: DbQueryClient, params: OutputScope]
) {
	const [db, params] = args;
	const store = readRuntime();
	const scope = await location(db, params.organizationId, params.outputId);
	if (!scope)
		throw new Error(
			"Workspace output writes require an activated workspace object",
		);
	const removed = await store.outputQuery(scope, {
		op: "delete",
		outputId: params.outputId,
	});
	if (removed) await refreshCommittedOutput(store, scope, params.outputId);
	// The file's images have no other owner. A failure leaves objects nothing
	// can reach, never a file without its images.
	if (removed)
		await deleteOutputAssets(params).catch((error) => {
			console.warn("os_output_assets_delete_failed", {
				outputId: params.outputId,
				error: error instanceof Error ? error.message : String(error),
			});
		});
	return removed;
}

export async function commitCollaborationOutput(
	params: CommitCollaborationOutputParams,
) {
	const scope = await requireWorkspaceOutputAuthority(params.proposal);
	const result = await readRuntime().outputQuery(scope, {
		op: "mergeProposal",
		...params,
	});
	if (result.ok)
		await refreshCommittedOutput(
			readRuntime(),
			scope,
			params.proposal.documentId,
		);
	return result;
}
