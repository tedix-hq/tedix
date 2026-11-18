import { and, eq } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { workspaceOutputIndex } from "../../schema/workspace-feed";
import type { DocumentTransferPackage } from "../durable-sqlite/output-rpc";

/** Move every revision location; the source object holds the document's write fence. */
export async function repointDocumentTransferIndex(
	db: DbQueryClient,
	organizationId: string,
	payload: DocumentTransferPackage,
) {
	const { transfer, snapshot } = payload;
	const scope = and(
		eq(workspaceOutputIndex.organizationId, organizationId),
		eq(workspaceOutputIndex.outputId, transfer.outputId),
	);
	const rows = await db.select().from(workspaceOutputIndex).where(scope);
	if (
		rows.length !== snapshot.revisions.length ||
		rows.some(
			(row) =>
				!snapshot.revisions.some(
					(revision) =>
						revision.id === row.revisionId &&
						revision.revision === row.revision,
				) ||
				![transfer.sourceWorkspaceId, transfer.targetWorkspaceId].includes(
					row.workspaceId,
				),
		)
	)
		throw new Error("Document transfer index conflicts with source revisions");
	await db
		.update(workspaceOutputIndex)
		.set({ workspaceId: transfer.targetWorkspaceId })
		.where(
			and(
				scope,
				eq(workspaceOutputIndex.workspaceId, transfer.sourceWorkspaceId),
			),
		);
	const moved = await db.select().from(workspaceOutputIndex).where(scope);
	if (moved.some((row) => row.workspaceId !== transfer.targetWorkspaceId))
		throw new Error("Document transfer index changed before confirmation");
}
