/**
 * A workspace object's own change ledger, in its SQLite storage.
 *
 * `append` runs synchronously so the object can call it inside the same
 * `transactionSync` as the write it describes: the ledger row and the data
 * row commit together, or neither does. `listFrom` serves `replayFrom`, and
 * `snapshot` gives the reconciler the object's side of the comparison.
 *
 * The storage parameter is structural (`exec` returning an iterable cursor)
 * so it accepts a Durable Object `SqlStorage` and any test double with the
 * same shape.
 */

import type {
	WorkspaceChangeEvent,
	WorkspaceChangeInput,
	WorkspaceFeedSnapshot,
} from "@tedix/api-contract/schemas/workspace-feed";
import {
	emptyWorkspaceFeedSnapshot,
	foldSnapshotEvent,
} from "@tedix/db/queries/workspace-feed/snapshot";

export interface WorkspaceFeedSqlStorage {
	exec<T extends Record<string, unknown> = Record<string, unknown>>(
		query: string,
		...bindings: unknown[]
	): { toArray(): T[] };
}

export interface WorkspaceFeedLedger {
	/** Record one change and allocate its `seq`. Synchronous: call it inside the write's transaction. */
	append(input: WorkspaceChangeInput): WorkspaceChangeEvent;
	/** Events from `fromSeq` upward, in order. */
	listFrom(fromSeq: number, limit?: number): WorkspaceChangeEvent[];
	lastSeq(): number;
	/** Per-kind counts and latest revisions over the whole ledger. */
	snapshot(): WorkspaceFeedSnapshot;
}

export const WORKSPACE_FEED_LEDGER_TABLE = "workspace_feed_ledger";

interface LedgerRow extends Record<string, unknown> {
	seq: number;
	organization_id: string;
	kind: WorkspaceChangeEvent["kind"];
	entity_id: string;
	revision: number;
	actor_kind: WorkspaceChangeEvent["actor"]["kind"];
	actor_id: string;
	change_record_id: string;
	summary: string;
	at: string;
}

export function createWorkspaceFeedLedger(
	sql: WorkspaceFeedSqlStorage,
	scope: { workspaceId: string },
): WorkspaceFeedLedger {
	sql.exec(
		`CREATE TABLE IF NOT EXISTS ${WORKSPACE_FEED_LEDGER_TABLE} (
			seq INTEGER PRIMARY KEY,
			organization_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			entity_id TEXT NOT NULL,
			revision INTEGER NOT NULL,
			actor_kind TEXT NOT NULL,
			actor_id TEXT NOT NULL,
			change_record_id TEXT NOT NULL,
			summary TEXT NOT NULL DEFAULT '{}',
			at TEXT NOT NULL
		)`,
	);
	sql.exec(
		`CREATE INDEX IF NOT EXISTS ${WORKSPACE_FEED_LEDGER_TABLE}_entity_idx ON ${WORKSPACE_FEED_LEDGER_TABLE} (kind, entity_id, revision)`,
	);

	const toEvent = (row: LedgerRow): WorkspaceChangeEvent => ({
		workspaceId: scope.workspaceId,
		organizationId: row.organization_id,
		kind: row.kind,
		id: row.entity_id,
		revision: Number(row.revision),
		actor: { kind: row.actor_kind, id: row.actor_id },
		changeRecordId: row.change_record_id,
		at: row.at,
		seq: Number(row.seq),
		summary: JSON.parse(row.summary) as WorkspaceChangeEvent["summary"],
	});

	const lastSeq = (): number => {
		const [row] = sql
			.exec<{ last: number | null }>(
				`SELECT MAX(seq) AS last FROM ${WORKSPACE_FEED_LEDGER_TABLE}`,
			)
			.toArray();
		return Number(row?.last ?? 0);
	};

	return {
		append(input) {
			if (input.workspaceId !== scope.workspaceId) {
				throw new Error(
					`WORKSPACE_FEED_SCOPE: ledger for ${scope.workspaceId} cannot record ${input.workspaceId}`,
				);
			}
			const seq = lastSeq() + 1;
			const summary = input.summary ?? {};
			sql.exec(
				`INSERT INTO ${WORKSPACE_FEED_LEDGER_TABLE} (seq, organization_id, kind, entity_id, revision, actor_kind, actor_id, change_record_id, summary, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				seq,
				input.organizationId,
				input.kind,
				input.id,
				input.revision,
				input.actor.kind,
				input.actor.id,
				input.changeRecordId,
				JSON.stringify(summary),
				input.at,
			);
			return { ...input, summary, seq };
		},
		listFrom(fromSeq, limit = 500) {
			return sql
				.exec<LedgerRow>(
					`SELECT * FROM ${WORKSPACE_FEED_LEDGER_TABLE} WHERE seq >= ? ORDER BY seq ASC LIMIT ?`,
					fromSeq,
					Math.min(Math.max(limit, 1), 5_000),
				)
				.toArray()
				.map(toEvent);
		},
		lastSeq,
		snapshot() {
			const snapshot = emptyWorkspaceFeedSnapshot(scope.workspaceId);
			const rows = sql
				.exec<Pick<LedgerRow, "seq" | "kind" | "entity_id" | "revision">>(
					`SELECT seq, kind, entity_id, revision FROM ${WORKSPACE_FEED_LEDGER_TABLE} ORDER BY seq ASC`,
				)
				.toArray();
			for (const row of rows) {
				foldSnapshotEvent(snapshot, {
					seq: Number(row.seq),
					kind: row.kind,
					id: row.entity_id,
					revision: Number(row.revision),
				});
			}
			return snapshot;
		},
	};
}
