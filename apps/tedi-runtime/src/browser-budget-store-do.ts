import type { DoSqlRunner } from "./brain-bridge-do";

export interface BrowserBudgetUsage {
	day: string;
	limit: number;
	remaining: number;
	used: number;
}

export class BrowserBudgetExceededError extends Error {
	readonly usage: BrowserBudgetUsage;

	constructor(usage: BrowserBudgetUsage) {
		super(
			`Browser daily budget exhausted for ${usage.day} (${usage.used}/${usage.limit} calls used)`,
		);
		this.name = "BrowserBudgetExceededError";
		this.usage = usage;
	}
}

export function browserBudgetDay(now = new Date()): string {
	return now.toISOString().slice(0, 10);
}

/**
 * Per-tedi Browser Run budget stored in the agent's own Durable Object SQLite.
 *
 * One successful native browser tool invocation consumes one unit. The guarded
 * UPDATE is atomic, so concurrent facet turns cannot overspend the configured
 * daily limit. Days are UTC to keep resets deterministic across runtime regions.
 */
export class DoBrowserBudgetStore {
	private readonly runner: DoSqlRunner;
	private schemaReady = false;
	private lastPrunedDay: string | null = null;

	constructor(runner: DoSqlRunner) {
		this.runner = runner;
	}

	private ensureSchema(): void {
		if (this.schemaReady) return;
		this.runner.sql`
			CREATE TABLE IF NOT EXISTS browser_daily_usage (
				day TEXT PRIMARY KEY,
				used INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`;
		this.schemaReady = true;
	}

	consume(limit: number, now = new Date()): BrowserBudgetUsage {
		this.ensureSchema();
		const day = browserBudgetDay(now);
		const boundedLimit = Math.max(0, Math.floor(limit));
		if (this.lastPrunedDay !== day) {
			this.runner.sql`DELETE FROM browser_daily_usage WHERE day < ${day}`;
			this.lastPrunedDay = day;
		}
		const updatedAt = now.getTime();
		this.runner.sql`
			INSERT OR IGNORE INTO browser_daily_usage (day, used, updated_at)
			VALUES (${day}, 0, ${updatedAt})
		`;
		const rows = this.runner.sql<{ used: number }>`
			UPDATE browser_daily_usage
			SET used = used + 1, updated_at = ${updatedAt}
			WHERE day = ${day} AND used < ${boundedLimit}
			RETURNING used
		`;
		const used = rows[0]?.used;
		if (used === undefined) {
			const current = this.runner.sql<{ used: number }>`
				SELECT used FROM browser_daily_usage WHERE day = ${day}
			`;
			const usage = {
				day,
				limit: boundedLimit,
				remaining: 0,
				used: current[0]?.used ?? 0,
			};
			throw new BrowserBudgetExceededError(usage);
		}
		return {
			day,
			limit: boundedLimit,
			remaining: Math.max(0, boundedLimit - used),
			used,
		};
	}

	status(limit: number, now = new Date()): BrowserBudgetUsage {
		this.ensureSchema();
		const day = browserBudgetDay(now);
		const boundedLimit = Math.max(0, Math.floor(limit));
		const rows = this.runner.sql<{ used: number }>`
			SELECT used FROM browser_daily_usage WHERE day = ${day}
		`;
		const used = rows[0]?.used ?? 0;
		return {
			day,
			limit: boundedLimit,
			remaining: Math.max(0, boundedLimit - used),
			used,
		};
	}
}
