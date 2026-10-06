/**
 * DO-side adapter around `src/brain/`.
 *
 * The brain modules are storage-neutral; this backs their `DedupStore` with
 * DO SQLite so the bridge quality envelope (priority gating, content-hash dedup, task
 * relevance, rate limits) stays single-source.
 *
 * v1 scope: persist content hashes only. The crystallizer / rationale-bridge
 * loops are not wired here yet — those are scheduled DO alarms in a follow-up.
 */

import type { DedupStore } from "./brain/dedup-types";

export interface DoSqlRunner {
	sql<T = Record<string, string | number | boolean | null>>(
		strings: TemplateStringsArray,
		...values: (string | number | boolean | null)[]
	): T[];
}

/**
 * Persists dedup hashes in the Agent's DO SQLite database.
 *
 * Schema is created lazily on first `add()`. Eviction is best-effort:
 * we cap the row count and delete the oldest rows when the cap is breached.
 */
export class DoDedupStore implements DedupStore {
	private readonly runner: DoSqlRunner;
	private readonly maxHashes: number;
	private readonly evictCount: number;
	private schemaReady = false;

	constructor(
		runner: DoSqlRunner,
		options: { maxHashes?: number; evictCount?: number } = {},
	) {
		this.runner = runner;
		this.maxHashes = options.maxHashes ?? 5000;
		this.evictCount = options.evictCount ?? 1000;
	}

	private ensureSchema(): void {
		if (this.schemaReady) return;
		this.runner.sql`
			CREATE TABLE IF NOT EXISTS brain_bridge_hashes (
				hash TEXT PRIMARY KEY,
				ts INTEGER NOT NULL
			)
		`;
		this.schemaReady = true;
	}

	async has(hash: string): Promise<boolean> {
		this.ensureSchema();
		const rows = this.runner.sql<{ c: number }>`
			SELECT COUNT(*) AS c FROM brain_bridge_hashes WHERE hash = ${hash}
		`;
		return (rows[0]?.c ?? 0) > 0;
	}

	async add(hash: string): Promise<void> {
		this.ensureSchema();
		const ts = Date.now();
		this.runner.sql`
			INSERT OR IGNORE INTO brain_bridge_hashes (hash, ts) VALUES (${hash}, ${ts})
		`;
		const countRows = this.runner.sql<{ c: number }>`
			SELECT COUNT(*) AS c FROM brain_bridge_hashes
		`;
		const count = countRows[0]?.c ?? 0;
		if (count > this.maxHashes) {
			const drop = this.evictCount;
			this.runner.sql`
				DELETE FROM brain_bridge_hashes
				WHERE hash IN (
					SELECT hash FROM brain_bridge_hashes
					ORDER BY ts ASC
					LIMIT ${drop}
				)
			`;
		}
	}

	async loadAll(): Promise<Set<string>> {
		this.ensureSchema();
		const rows = this.runner.sql<{ hash: string }>`
			SELECT hash FROM brain_bridge_hashes
		`;
		return new Set(rows.map((r) => r.hash));
	}
}
