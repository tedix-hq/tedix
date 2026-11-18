import type { DbQueryClient } from "../../query-client";
import {
	osWorkspaceResources,
	type NewOsWorkspaceResourceRow,
	type NewOsOutputRow,
	type NewOsOutputRevisionRow,
} from "../../schema/os-workspaces";

/** Resource metadata stays in shared D1; document rows belong to the workspace object. */
export async function confirmOsWorkspaceFile(
	db: DbQueryClient,
	params: {
		resource?: NewOsWorkspaceResourceRow;
		output?: NewOsOutputRow;
		revision?: NewOsOutputRevisionRow;
	},
) {
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
