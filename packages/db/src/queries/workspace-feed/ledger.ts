/**
 * Core-side workspace change ledger (`workspace_feed_ledger`).
 *
 * The core API still writes outputs today, so it is the "workspace object"
 * for those writes: it appends here, allocating the next per-workspace `seq`,
 * and sends the event through the queue. A workspace object with its own
 * SQLite uses `@tedix/workspace-feed/ledger` instead; both expose the same
 * append / list / snapshot shape so `replayFrom` and the reconciler do not
 * care which side holds the history.
 */

import type {
	WorkspaceChangeEvent,
	WorkspaceChangeInput,
	WorkspaceFeedSnapshot,
} from "@tedix/api-contract/schemas/workspace-feed";
import { and, asc, eq, gte, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import {
	type WorkspaceFeedLedgerRow,
	workspaceFeedLedger,
} from "../../schema/workspace-feed";
import { emptyWorkspaceFeedSnapshot, foldSnapshotEvent } from "./snapshot";

const APPEND_ATTEMPTS = 5;

function toEvent(row: WorkspaceFeedLedgerRow): WorkspaceChangeEvent {
	return {
		workspaceId: row.workspaceId,
		organizationId: row.organizationId,
		kind: row.kind,
		id: row.entityId,
		revision: row.revision,
		actor: { kind: row.actorKind, id: row.actorId },
		changeRecordId: row.changeRecordId,
		at: row.at,
		seq: row.seq,
		summary: JSON.parse(row.summary) as WorkspaceChangeEvent["summary"],
	};
}

/**
 * Append one change and allocate its `seq`. D1 has no transactions, so the
 * next sequence is read, then inserted under the `(workspace_id, seq)`
 * unique index; a concurrent writer that took the same number makes the
 * insert fail and the append retries with a fresh read.
 */
export async function appendWorkspaceFeedLedger(
	db: DbQueryClient,
	input: WorkspaceChangeInput,
): Promise<WorkspaceChangeEvent> {
	let lastError: unknown;
	for (let attempt = 0; attempt < APPEND_ATTEMPTS; attempt += 1) {
		const seq = (await lastWorkspaceFeedLedgerSeq(db, input.workspaceId)) + 1;
		const summary = input.summary ?? {};
		try {
			const [row] = await db
				.insert(workspaceFeedLedger)
				.values({
					id: `${input.workspaceId}:${seq}`,
					organizationId: input.organizationId,
					workspaceId: input.workspaceId,
					seq,
					kind: input.kind,
					entityId: input.id,
					revision: input.revision,
					actorKind: input.actor.kind,
					actorId: input.actor.id,
					changeRecordId: input.changeRecordId,
					summary: JSON.stringify(summary),
					at: input.at,
				})
				.returning();
			if (row) return toEvent(row);
		} catch (error) {
			lastError = error;
		}
	}
	throw new Error(
		`WORKSPACE_FEED_APPEND_CONFLICT: could not allocate a sequence for workspace ${input.workspaceId}: ${
			lastError instanceof Error ? lastError.message : String(lastError)
		}`,
	);
}

export async function lastWorkspaceFeedLedgerSeq(
	db: DbQueryClient,
	workspaceId: string,
): Promise<number> {
	const [row] = await db
		.select({
			lastSeq: sql<number>`COALESCE(MAX(${workspaceFeedLedger.seq}), 0)`,
		})
		.from(workspaceFeedLedger)
		.where(eq(workspaceFeedLedger.workspaceId, workspaceId));
	return Number(row?.lastSeq ?? 0);
}

export async function listWorkspaceFeedLedger(
	db: DbQueryClient,
	params: { workspaceId: string; fromSeq: number; limit?: number },
): Promise<WorkspaceChangeEvent[]> {
	const rows = await db
		.select()
		.from(workspaceFeedLedger)
		.where(
			and(
				eq(workspaceFeedLedger.workspaceId, params.workspaceId),
				gte(workspaceFeedLedger.seq, params.fromSeq),
			),
		)
		.orderBy(asc(workspaceFeedLedger.seq))
		.limit(Math.min(Math.max(params.limit ?? 500, 1), 5_000));
	return rows.map(toEvent);
}

/** Per-kind counts and latest revisions as the ledger records them. */
export async function snapshotWorkspaceFeedLedger(
	db: DbQueryClient,
	workspaceId: string,
): Promise<WorkspaceFeedSnapshot> {
	const snapshot = emptyWorkspaceFeedSnapshot(workspaceId);
	const pageSize = 2_000;
	let fromSeq = 1;
	for (;;) {
		const page = await listWorkspaceFeedLedger(db, {
			workspaceId,
			fromSeq,
			limit: pageSize,
		});
		for (const event of page) foldSnapshotEvent(snapshot, event);
		if (page.length < pageSize) break;
		fromSeq = (page[page.length - 1]?.seq ?? fromSeq) + 1;
	}
	return snapshot;
}
