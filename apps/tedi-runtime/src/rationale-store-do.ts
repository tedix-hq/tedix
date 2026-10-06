/**
 * DO-side RationaleStateStore implementation.
 *
 * Mirrors `brain-bridge-do.ts` (DoDedupStore). Container tedis back the
 * rationale bridge state with a JSON file on the workspace dir; isolate tedis
 * back it with DO SQLite. Same `RationaleStateStore` interface so the bridge
 * stays runtime-neutral.
 *
 * Schema (created lazily on first call):
 *   rationale_open_records(id PRIMARY KEY, action_hash, action, category, created_at)
 *
 * Eviction: cap open records and best-effort delete the oldest rows when the
 * cap is breached. The bridge itself prunes stale records (>24h), so this is a
 * safety net for runaway scenarios.
 */

import type {
	RationaleBridgeState,
	RationaleStateStore,
} from "./brain/rationale-bridge";
import type { DoSqlRunner } from "./brain-bridge-do";

interface OpenRecordRow {
	id: string;
	action_hash: string;
	action: string;
	category: string;
	created_at: number;
}

export class DoRationaleStateStore implements RationaleStateStore {
	private readonly runner: DoSqlRunner;
	private readonly maxRecords: number;
	private readonly evictCount: number;
	private schemaReady = false;

	constructor(
		runner: DoSqlRunner,
		options: { maxRecords?: number; evictCount?: number } = {},
	) {
		this.runner = runner;
		this.maxRecords = options.maxRecords ?? 1000;
		this.evictCount = options.evictCount ?? 200;
	}

	private ensureSchema(): void {
		if (this.schemaReady) return;
		this.runner.sql`
			CREATE TABLE IF NOT EXISTS rationale_open_records (
				id TEXT PRIMARY KEY,
				action_hash TEXT NOT NULL,
				action TEXT NOT NULL,
				category TEXT NOT NULL,
				created_at INTEGER NOT NULL
			)
		`;
		this.schemaReady = true;
	}

	async load(): Promise<RationaleBridgeState> {
		this.ensureSchema();
		const rows = this.runner.sql<OpenRecordRow>`
			SELECT id, action_hash, action, category, created_at
			FROM rationale_open_records
			ORDER BY created_at ASC
		`;
		return {
			records: rows.map((r) => ({
				id: r.id,
				actionHash: r.action_hash,
				action: r.action,
				category: r.category,
				createdAt: r.created_at,
			})),
		};
	}

	async save(state: RationaleBridgeState): Promise<void> {
		this.ensureSchema();
		// Full-replace pattern: bridge owns the canonical state per turn.
		// DO storage is local + fast; this stays cheap at our row counts.
		this.runner.sql`DELETE FROM rationale_open_records`;
		for (const rec of state.records) {
			this.runner.sql`
				INSERT INTO rationale_open_records
					(id, action_hash, action, category, created_at)
				VALUES
					(${rec.id}, ${rec.actionHash}, ${rec.action}, ${rec.category}, ${rec.createdAt})
			`;
		}

		// Safety-net eviction (bridge already caps at MAX_OPEN=50, but guard the
		// table in case of bugs / future config changes).
		const countRows = this.runner.sql<{ c: number }>`
			SELECT COUNT(*) AS c FROM rationale_open_records
		`;
		const count = countRows[0]?.c ?? 0;
		if (count > this.maxRecords) {
			const drop = this.evictCount;
			this.runner.sql`
				DELETE FROM rationale_open_records
				WHERE id IN (
					SELECT id FROM rationale_open_records
					ORDER BY created_at ASC
					LIMIT ${drop}
				)
			`;
		}
	}
}
