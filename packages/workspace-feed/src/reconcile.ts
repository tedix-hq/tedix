/**
 * Drift check between a workspace object and the core projection.
 *
 * Both sides fold their records into the same `WorkspaceFeedSnapshot`
 * (sequence position, per-kind record and event counts, latest revision per
 * record). The diff lists every difference; an empty list means the
 * projection holds exactly what the object has emitted.
 */

import type {
	WorkspaceChangeKind,
	WorkspaceFeedSnapshot,
} from "@tedix/api-contract/schemas/workspace-feed";
import { snapshotWorkspaceProjection } from "@tedix/db/queries/workspace-feed/reconcile";
import type { DbQueryClient } from "@tedix/db/query-client";

export type WorkspaceFeedDrift =
	| { kind: "cursor"; objectSeq: number; projectionSeq: number }
	| {
			kind: "count";
			changeKind: WorkspaceChangeKind;
			field: "records" | "events";
			object: number;
			projection: number;
	  }
	| {
			kind: "revision";
			changeKind: WorkspaceChangeKind;
			id: string;
			object: number | null;
			projection: number | null;
	  };

export interface WorkspaceFeedReconcileReport {
	workspaceId: string;
	object: WorkspaceFeedSnapshot;
	projection: WorkspaceFeedSnapshot;
	drift: WorkspaceFeedDrift[];
	/** Where `replayFrom` should start to close the gap, when the projection is behind. */
	replayFromSeq: number | null;
	/** Drift below the applied cursor cannot be repaired by ordinary redelivery. */
	rebuildRequired: boolean;
}

const KINDS: WorkspaceChangeKind[] = [
	"output",
	"run",
	"artifact",
	"memory",
	"chat",
];

export function diffWorkspaceFeedSnapshots(
	object: WorkspaceFeedSnapshot,
	projection: WorkspaceFeedSnapshot,
): WorkspaceFeedDrift[] {
	const drift: WorkspaceFeedDrift[] = [];
	if (object.lastSeq !== projection.lastSeq) {
		drift.push({
			kind: "cursor",
			objectSeq: object.lastSeq,
			projectionSeq: projection.lastSeq,
		});
	}
	for (const changeKind of KINDS) {
		const left = object.kinds[changeKind];
		const right = projection.kinds[changeKind];
		if (!left && !right) continue;
		for (const field of ["records", "events"] as const) {
			const a = left?.[field] ?? 0;
			const b = right?.[field] ?? 0;
			if (a !== b)
				drift.push({
					kind: "count",
					changeKind,
					field,
					object: a,
					projection: b,
				});
		}
		const ids = new Set([
			...Object.keys(left?.latest ?? {}),
			...Object.keys(right?.latest ?? {}),
		]);
		for (const id of [...ids].sort()) {
			const a = left?.latest[id] ?? null;
			const b = right?.latest[id] ?? null;
			if (a !== b)
				drift.push({
					kind: "revision",
					changeKind,
					id,
					object: a,
					projection: b,
				});
		}
	}
	return drift;
}

export async function reconcileWorkspaceFeed(
	db: DbQueryClient,
	object: WorkspaceFeedSnapshot,
): Promise<WorkspaceFeedReconcileReport> {
	const projection = await snapshotWorkspaceProjection(db, object.workspaceId);
	const drift = diffWorkspaceFeedSnapshots(object, projection);
	return {
		workspaceId: object.workspaceId,
		object,
		projection,
		drift,
		replayFromSeq:
			object.lastSeq > projection.lastSeq ? projection.lastSeq + 1 : null,
		rebuildRequired: drift.length > 0 && object.lastSeq <= projection.lastSeq,
	};
}
