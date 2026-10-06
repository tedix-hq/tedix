/**
 * DO-side adapter for Work Item promotion idempotency.
 *
 * Mirrors `DoDedupStore` (brain-bridge-do.ts): the `src/brain/`
 * task-bridge is runtime-neutral and persists nothing itself. The Agent runtime
 * backs promotion dedup with DO SQLite so a given task intent is promoted to a
 * canonical Work Item exactly once across turns and DO restarts.
 *
 * Both satisfy `WorkItemPromotionStore` so the promotion policy + RPC wiring
 * stays single-source in brain-bridge.
 */

import type {
	WorkItemPromotionRef,
	WorkItemPromotionStore,
} from "./brain/task-bridge";
import type { DoSqlRunner } from "./brain-bridge-do";

/**
 * Persists promoted-intent idempotency keys (+ the resulting Work Item ref) in
 * the Agent's DO SQLite database. Schema created lazily on first access.
 * Eviction is best-effort: cap the row count, drop oldest on breach.
 */
export class DoWorkItemPromotionStore implements WorkItemPromotionStore {
	private readonly runner: DoSqlRunner;
	private readonly maxRows: number;
	private readonly evictCount: number;
	/** Rolling window for the per-session promotion cap (default 1 hour). */
	private readonly sessionWindowMs: number;
	private schemaReady = false;

	constructor(
		runner: DoSqlRunner,
		options: {
			maxRows?: number;
			evictCount?: number;
			sessionWindowMs?: number;
		} = {},
	) {
		this.runner = runner;
		this.maxRows = options.maxRows ?? 5000;
		this.evictCount = options.evictCount ?? 1000;
		this.sessionWindowMs = options.sessionWindowMs ?? 60 * 60 * 1000;
	}

	private ensureSchema(): void {
		if (this.schemaReady) return;
		this.runner.sql`
			CREATE TABLE IF NOT EXISTS work_item_promotions (
				idempotency_key TEXT PRIMARY KEY,
				work_item_id TEXT NOT NULL,
				title TEXT NOT NULL,
				source_session_key TEXT,
				ts INTEGER NOT NULL
			)
		`;
		// Migrate tables created before `source_session_key` existed. ALTER throws
		// "duplicate column" on already-migrated tables — swallow it.
		try {
			this.runner.sql`
				ALTER TABLE work_item_promotions ADD COLUMN source_session_key TEXT
			`;
		} catch {
			/* column already present */
		}
		this.schemaReady = true;
	}

	async has(idempotencyKey: string): Promise<boolean> {
		this.ensureSchema();
		const rows = this.runner.sql<{ c: number }>`
			SELECT COUNT(*) AS c FROM work_item_promotions
			WHERE idempotency_key = ${idempotencyKey}
		`;
		return (rows[0]?.c ?? 0) > 0;
	}

	async add(
		idempotencyKey: string,
		ref: WorkItemPromotionRef,
		sessionKey?: string,
	): Promise<void> {
		this.ensureSchema();
		const ts = Date.now();
		this.runner.sql`
			INSERT OR IGNORE INTO work_item_promotions
				(idempotency_key, work_item_id, title, source_session_key, ts)
			VALUES (${idempotencyKey}, ${ref.id}, ${ref.title}, ${sessionKey ?? null}, ${ts})
		`;
		const countRows = this.runner.sql<{ c: number }>`
			SELECT COUNT(*) AS c FROM work_item_promotions
		`;
		const count = countRows[0]?.c ?? 0;
		if (count > this.maxRows) {
			const drop = this.evictCount;
			this.runner.sql`
				DELETE FROM work_item_promotions
				WHERE idempotency_key IN (
					SELECT idempotency_key FROM work_item_promotions
					ORDER BY ts ASC
					LIMIT ${drop}
				)
			`;
		}
	}

	/**
	 * Count Work Items promoted for this session within the rolling window.
	 * Backs the per-session promotion cap so a chatty session cannot mint dozens
	 * of Work Items across many turns. Windowed so a long-lived session
	 * (`agent:main:main`) is never permanently blocked once it hits the cap.
	 */
	async countForSession(sessionKey: string): Promise<number> {
		this.ensureSchema();
		const since = Date.now() - this.sessionWindowMs;
		const rows = this.runner.sql<{ c: number }>`
			SELECT COUNT(*) AS c FROM work_item_promotions
			WHERE source_session_key = ${sessionKey} AND ts >= ${since}
		`;
		return rows[0]?.c ?? 0;
	}
}
