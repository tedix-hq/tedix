import type { OsWorkspaceScopeParams } from "../os-workspaces/workspaces";
import type {
	NewOsOutputRow,
	NewOsOutputRevisionRow,
} from "../../schema/os-workspaces";
import type { TenantStoreDb } from "./tenant-store";
import * as outputs from "./os-outputs";

export type OutputTransferSnapshot = outputs.OutputTransferSnapshot;
export type OutputTransferResult =
	| { ok: true; output: NonNullable<OutputQueryResults["get"]> }
	| { ok: false; reason: "not_found" | "conflict" };

export interface OutputQueryInputs {
	authority: unknown;
	snapshot: { outputId: string };
	import: { snapshot: OutputTransferSnapshot };
	list: { options?: outputs.ListOsOutputsOptions };
	activeSheet: { title: string };
	get: { outputId: string };
	revision: { revisionId: string };
	revisionByNumber: { outputId: string; revision: number };
	history: {
		outputId: string;
		options?: { limit?: number; beforeRevision?: number };
	};
	create: { output: NewOsOutputRow; revision: NewOsOutputRevisionRow };
	revise: { params: outputs.CreateOsOutputRevisionParams };
	update: { outputId: string; patch: outputs.UpdateOsOutputPatch };
	delete: { outputId: string };
}

export interface OutputQueryResults {
	authority: "object" | "shared";
	snapshot: Awaited<ReturnType<typeof outputs.snapshotOutput>>;
	import: Awaited<ReturnType<typeof outputs.importOutput>>;
	list: Awaited<ReturnType<typeof outputs.listOsOutputs>>;
	activeSheet: Awaited<ReturnType<typeof outputs.getActiveSheetByTitle>>;
	get: Awaited<ReturnType<typeof outputs.getOsOutput>>;
	revision: Awaited<ReturnType<typeof outputs.getOsOutputRevision>>;
	revisionByNumber: Awaited<
		ReturnType<typeof outputs.getOsOutputRevisionByNumber>
	>;
	history: Awaited<ReturnType<typeof outputs.listOsOutputRevisions>>;
	create: Awaited<ReturnType<typeof outputs.createOsOutput>>;
	revise: Awaited<ReturnType<typeof outputs.createOsOutputRevision>>;
	update: Awaited<ReturnType<typeof outputs.updateOsOutput>>;
	delete: Awaited<ReturnType<typeof outputs.deleteOsOutput>>;
}

export type OutputOperation = keyof OutputQueryInputs;
export type OutputQuery<K extends OutputOperation = OutputOperation> = {
	[P in K]: { op: P } & OutputQueryInputs[P];
}[K];
export type OutputQueryResult<K extends OutputOperation = OutputOperation> =
	OutputQueryResults[K];

export interface WorkspaceOutputRuntime {
	transferOutput(
		scope: OsWorkspaceScopeParams,
		outputId: string,
		targetWorkspaceId: string,
	): Promise<OutputTransferResult>;
	refreshOutputProjection(
		scope: OsWorkspaceScopeParams,
		outputId: string,
	): Promise<void>;
	outputQuery<K extends OutputOperation>(
		scope: OsWorkspaceScopeParams,
		query: OutputQuery<K>,
	): Promise<OutputQueryResult<K>>;
}

/** Internal storage RPC. The API authorizes the caller; this boundary fences every row to its object. */
export async function executeOutputQuery<K extends OutputOperation>(
	db: TenantStoreDb,
	scope: OsWorkspaceScopeParams,
	query: OutputQuery<K>,
): Promise<OutputQueryResult<K>> {
	return execute(db, scope, query as OutputQuery) as Promise<
		OutputQueryResult<K>
	>;
}

async function execute(
	db: TenantStoreDb,
	scope: OsWorkspaceScopeParams,
	query: OutputQuery,
): Promise<OutputQueryResult> {
	const owned = async (outputId: string) => {
		const row = await outputs.getOsOutput(db, {
			organizationId: scope.organizationId,
			outputId,
		});
		if (row && row.workspaceId !== scope.workspaceId)
			throw new Error("Output is outside this workspace");
		return row;
	};
	const params = (outputId: string) => ({
		organizationId: scope.organizationId,
		outputId,
	});
	switch (query.op) {
		case "authority":
			throw new Error("Workspace authority requires the shared inventory");
		case "snapshot":
			if (!(await owned(query.outputId))) return undefined;
			return outputs.snapshotOutput(db, params(query.outputId));
		case "import":
			if (
				query.snapshot.output.organizationId !== scope.organizationId ||
				query.snapshot.output.workspaceId !== scope.workspaceId
			)
				throw new Error("Output transfer scope mismatch");
			return outputs.importOutput(db, query.snapshot);
		case "activeSheet":
			return outputs.getActiveSheetByTitle(db, {
				...scope,
				title: query.title,
			});
		case "list":
			return outputs.listOsOutputs(
				db,
				scope.organizationId,
				{ userIds: [], workspaceIds: [scope.workspaceId] },
				{ ...query.options, workspaceId: scope.workspaceId },
			);
		case "get":
			return owned(query.outputId);
		case "revision": {
			const revision = await outputs.getOsOutputRevision(db, {
				organizationId: scope.organizationId,
				revisionId: query.revisionId,
			});
			if (revision && !(await owned(revision.outputId))) return undefined;
			return revision;
		}
		case "revisionByNumber":
			if (!(await owned(query.outputId))) return undefined;
			return outputs.getOsOutputRevisionByNumber(db, {
				...params(query.outputId),
				revision: query.revision,
			});
		case "history":
			if (!(await owned(query.outputId))) return [];
			return outputs.listOsOutputRevisions(
				db,
				params(query.outputId),
				query.options,
			);
		case "create":
			if (
				query.output.organizationId !== scope.organizationId ||
				query.output.workspaceId !== scope.workspaceId ||
				query.revision.organizationId !== scope.organizationId ||
				query.revision.outputId !== query.output.id
			)
				throw new Error("Output create scope mismatch");
			return outputs.createOsOutput(db, query.output, query.revision);
		case "revise":
			if (query.params.organizationId !== scope.organizationId)
				throw new Error("Output revision scope mismatch");
			await owned(query.params.outputId);
			return outputs.createOsOutputRevision(db, query.params);
		case "update":
			await owned(query.outputId);
			if (
				query.patch.workspaceId &&
				query.patch.workspaceId !== scope.workspaceId
			)
				throw new Error(
					"Moving a workspace output requires an explicit transfer",
				);
			return outputs.updateOsOutput(db, params(query.outputId), query.patch);
		case "delete":
			await owned(query.outputId);
			return outputs.deleteOsOutput(db, params(query.outputId));
	}
}
