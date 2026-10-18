import type { DbQueryClient } from "../../query-client";
import {
	osWorkspaceResources,
	osOutputs,
	osOutputRevisions,
	type NewOsWorkspaceResourceRow,
	type NewOsOutputRow,
	type NewOsOutputRevisionRow,
} from "../../schema/os-workspaces";

/** One immutable upload becomes a Resource and an Output in the same D1 batch. */
export async function confirmOsWorkspaceFile(
	db: DbQueryClient,
	params: {
		resource: NewOsWorkspaceResourceRow;
		output: NewOsOutputRow;
		revision: NewOsOutputRevisionRow;
	},
) {
	await db.batch([
		db
			.insert(osWorkspaceResources)
			.values(params.resource)
			.onConflictDoNothing(),
		db.insert(osOutputs).values(params.output).onConflictDoNothing(),
		db.insert(osOutputRevisions).values(params.revision).onConflictDoNothing(),
	]);
}
