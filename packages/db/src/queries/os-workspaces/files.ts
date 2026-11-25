import type { DbQueryClient } from "../../query-client";
import { coreTable } from "../../core-store/client";
import {
	osWorkspaceResources as d1OsWorkspaceResources,
	type NewOsWorkspaceResourceRow,
} from "../../schema/os-workspaces";
import {
	type NewOsOutputRow,
	type NewOsOutputRevisionRow,
} from "../../tenant-store/outputs-schema";

/** Resource metadata stays in shared D1; document rows belong to the workspace object. */
export async function confirmOsWorkspaceFile(
	db: DbQueryClient,
	params: {
		resource?: NewOsWorkspaceResourceRow;
		output?: NewOsOutputRow;
		revision?: NewOsOutputRevisionRow;
	},
) {
	const osWorkspaceResources = coreTable(db, d1OsWorkspaceResources);
	if (params.output || params.revision)
		throw new Error(
			"File document writes require the workspace object service",
		);
	if (!params.resource)
		throw new Error("confirmOsWorkspaceFile needs a resource to write");
	await db
		.insert(osWorkspaceResources)
		.values(params.resource)
		.onConflictDoNothing();
}
