import type { BatchItem } from "drizzle-orm/batch";
import type { DbQueryClient } from "../../query-client";
import {
	osWorkspaceResources,
	osOutputs,
	osOutputRevisions,
	type NewOsWorkspaceResourceRow,
	type NewOsOutputRow,
	type NewOsOutputRevisionRow,
} from "../../schema/os-workspaces";

/**
 * One immutable upload becomes a Resource — and, when the caller asked for a
 * document, an Output — in the same D1 batch. A resource that was retained
 * without a document can gain the Output later through the same statements.
 */
export async function confirmOsWorkspaceFile(
	db: DbQueryClient,
	params: {
		resource?: NewOsWorkspaceResourceRow;
		output?: NewOsOutputRow;
		revision?: NewOsOutputRevisionRow;
	},
) {
	const statements: BatchItem<"sqlite">[] = [];
	if (params.resource)
		statements.push(
			db
				.insert(osWorkspaceResources)
				.values(params.resource)
				.onConflictDoNothing(),
		);
	if (params.output)
		statements.push(
			db.insert(osOutputs).values(params.output).onConflictDoNothing(),
		);
	if (params.revision)
		statements.push(
			db
				.insert(osOutputRevisions)
				.values(params.revision)
				.onConflictDoNothing(),
		);
	const [first, ...rest] = statements;
	if (!first) throw new Error("confirmOsWorkspaceFile needs a row to write");
	await db.batch([first, ...rest]);
}
