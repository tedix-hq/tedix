/**
 * The projection's view of one workspace, in the same snapshot shape a
 * ledger produces, so the reconciler can diff the two.
 */

import type { WorkspaceFeedSnapshot } from "@tedix/api-contract/schemas/workspace-feed";
import { and, asc, eq, gt } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { workspaceActivity } from "../../schema/workspace-feed";
import { getWorkspaceFeedCursor } from "./projection";
import { emptyWorkspaceFeedSnapshot, foldSnapshotEvent } from "./snapshot";

export async function snapshotWorkspaceProjection(
	db: DbQueryClient,
	workspaceId: string,
): Promise<WorkspaceFeedSnapshot> {
	const snapshot = emptyWorkspaceFeedSnapshot(workspaceId);
	const pageSize = 2_000;
	let afterSeq = 0;
	for (;;) {
		const page = await db
			.select({
				seq: workspaceActivity.seq,
				kind: workspaceActivity.kind,
				id: workspaceActivity.entityId,
				revision: workspaceActivity.revision,
			})
			.from(workspaceActivity)
			.where(
				and(
					eq(workspaceActivity.workspaceId, workspaceId),
					gt(workspaceActivity.seq, afterSeq),
				),
			)
			.orderBy(asc(workspaceActivity.seq))
			.limit(pageSize);
		for (const row of page) foldSnapshotEvent(snapshot, row);
		if (page.length < pageSize) break;
		afterSeq = page[page.length - 1]?.seq ?? afterSeq;
	}
	// The cursor is the applied position even when the activity list was pruned.
	snapshot.lastSeq = Math.max(
		snapshot.lastSeq,
		await getWorkspaceFeedCursor(db, workspaceId),
	);
	return snapshot;
}
