import type { CommitCollaborationOutputParams } from "@tedix/db/queries/os-workspaces/collaboration";
import { env, waitUntil } from "cloudflare:workers";
import type { TenantScope } from "@tedix/db/tenant-scope";
import type {
	NewOsOutputRow,
	NewOsOutputRevisionRow,
} from "@tedix/db/tenant-store/outputs-schema";
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
import { markRowsRead } from "@tedix/db/queries/read-marks";
import type { OsWorkspaceRow } from "@tedix/db/schema/os-workspaces";
import {
	getOsWorkspace,
	isOsWorkspaceVisibleTo,
	type OsWorkspaceScopeParams,
	type OsWorkspaceViewer,
} from "@tedix/db/queries/os-workspaces/workspaces";
import { outputLibraryRowsFromIndex } from "./os-output-library";
import { deleteOutputAssets } from "./os-output-assets";

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
	const row = await store.outputQuery(scope, {
		op: "get",
		outputId: args[1].outputId,
	});
	if (row)
		await markRowsRead(args[0], args[1].organizationId, "output", [
			args[1].outputId,
		]);
	return row;
}

export type MoveOsOutputResult =
	| OutputTransferResult
	| { ok: false; reason: "source_not_ready" };

export async function moveOsOutput(
	_db: DbQueryClient,
	output: NonNullable<Awaited<ReturnType<typeof getOsOutput>>>,
	targetWorkspaceId: string,
): Promise<MoveOsOutputResult> {
	const store = readRuntime();
	const { organizationId, workspaceId } = output;
	if (!workspaceId) return { ok: false, reason: "source_not_ready" };
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
		workspace?: OsWorkspaceRow,
	]
) {
	const [db, scope, viewer, options = {}, knownWorkspace] = args;
	let objectRows;
	if (scope.workspaceId) {
		const workspace =
			knownWorkspace ??
			(await getOsWorkspace(db, {
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
			}));
		if (
			!workspace ||
			workspace.id !== scope.workspaceId ||
			workspace.organizationId !== scope.organizationId ||
			!isOsWorkspaceVisibleTo(workspace, viewer)
		)
			return [];
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
	const rows = objectRows
		.sort(
			(a, b) =>
				b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id),
		)
		.slice(0, options.limit ?? 100);
	await markRowsRead(
		db,
		scope.organizationId,
		"output",
		rows.map((row) => row.id),
	);
	return rows;
}

/**
 * A caller that already holds the output passes its `workspaceId`. The
 * revision index is filled by the feed publish, which a save no longer waits
 * for, so a save straight after another would miss it.
 */
export async function getOsOutputRevision(
	...args: [
		db: DbQueryClient,
		params: TenantScope & { revisionId: string; workspaceId?: string },
	]
) {
	const store = readRuntime();
	const { organizationId, revisionId, workspaceId } = args[1];
	const scope = workspaceId
		? { organizationId, workspaceId }
		: await getWorkspaceOutputIndexRevision(args[0], args[1]);
	const row = scope
		? await store.outputQuery(
				{
					organizationId: scope.organizationId,
					workspaceId: scope.workspaceId,
				},
				{ op: "revision", revisionId },
			)
		: undefined;
	if (row)
		await markRowsRead(args[0], organizationId, "output", [row.outputId]);
	return row;
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
	const row = scope
		? await store.outputQuery(scope, {
				op: "revisionByNumber",
				outputId: args[1].outputId,
				revision: args[1].revision,
			})
		: undefined;
	if (row)
		await markRowsRead(args[0], args[1].organizationId, "output", [
			args[1].outputId,
		]);
	return row;
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
	const rows = scope
		? await store.outputQuery(scope, {
				op: "history",
				outputId: args[1].outputId,
				options: args[2],
			})
		: [];
	if (rows.length > 0)
		await markRowsRead(args[0], args[1].organizationId, "output", [
			args[1].outputId,
		]);
	return rows;
}

export function requireWorkspaceOutputScope(scope: {
	organizationId: string;
	workspaceId?: string | null;
}) {
	if (!scope.workspaceId)
		throw new Error("Workspace output requires a workspace");
	return {
		organizationId: scope.organizationId,
		workspaceId: scope.workspaceId,
	};
}

export async function createOsOutput(...args: CreateOutputArgs) {
	const [, scope, output, revision, excerpt] = args;
	const store = readRuntime();
	const bound = requireWorkspaceOutputScope({
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
	const bound = requireWorkspaceOutputScope({
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
	db: DbQueryClient,
	params: RevisionParams,
	excerpt?: string,
	lap?: (stage: string) => void,
) {
	const store = readRuntime();
	const scope = await readLocation(db, params.organizationId, params.outputId);
	lap?.("commitLocationMs");
	if (!scope) throw new Error("Workspace output location is missing");
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
	lap?.("commitMs");
	if (
		result.ok &&
		result.revision.id === params.id &&
		!result.projectionQueued
	) {
		await refreshCommittedOutput(store, scope, params.outputId);
		lap?.("refreshMs");
	}
	return result;
}

export async function updateOsOutput(
	...args: [db: DbQueryClient, params: OutputScope, patch: UpdateOsOutputPatch]
) {
	const store = readRuntime();
	const scope = await readLocation(
		args[0],
		args[1].organizationId,
		args[1].outputId,
	);
	if (!scope) throw new Error("Workspace output location is missing");
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
	const row = await readRuntime().outputQuery(
		{
			organizationId: args[1].organizationId,
			workspaceId: args[1].workspaceId,
		},
		{ op: "activeSheet", title: args[1].title },
	);
	if (row)
		await markRowsRead(args[0], args[1].organizationId, "output", [
			row.output.id,
		]);
	return row;
}

export async function deleteOsOutput(
	...args: [db: DbQueryClient, params: OutputScope]
) {
	const [db, params] = args;
	const store = readRuntime();
	const scope = await readLocation(db, params.organizationId, params.outputId);
	if (!scope) throw new Error("Workspace output location is missing");
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
	const scope = requireWorkspaceOutputScope(params.proposal);
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
