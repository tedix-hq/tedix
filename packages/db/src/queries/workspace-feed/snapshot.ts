/**
 * Snapshot folding shared by every ledger and by the projection: the same
 * reduction on both sides is what makes the reconciler's comparison honest.
 */

import type {
	WorkspaceChangeKind,
	WorkspaceFeedSnapshot,
} from "@tedix/api-contract/schemas/workspace-feed";

export function emptyWorkspaceFeedSnapshot(
	workspaceId: string,
): WorkspaceFeedSnapshot {
	return { workspaceId, lastSeq: 0, kinds: {} };
}

export function foldSnapshotEvent(
	snapshot: WorkspaceFeedSnapshot,
	event: {
		seq: number;
		kind: WorkspaceChangeKind;
		id: string;
		revision: number;
	},
): void {
	snapshot.lastSeq = Math.max(snapshot.lastSeq, event.seq);
	const bucket = (snapshot.kinds[event.kind] ??= {
		records: 0,
		events: 0,
		latest: {},
	});
	bucket.events += 1;
	const known = bucket.latest[event.id];
	if (known === undefined) bucket.records += 1;
	bucket.latest[event.id] = Math.max(known ?? 0, event.revision);
}
