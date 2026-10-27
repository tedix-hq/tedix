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
		this.runner.sql`
			CREATE TABLE IF NOT EXISTS browser_session_windows (
				session_id TEXT PRIMARY KEY,
				started_at INTEGER NOT NULL,
				last_seen_at INTEGER NOT NULL,
				keep_alive_ms INTEGER NOT NULL,
				ended_at INTEGER
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

	/**
	 * Record that the persistent browser `sessionId` was resolved alive at
	 * `now`. A session the provider must already have reclaimed (idle past its
	 * keep-alive) is settled at that expiry; live ones accrue to `now`.
	 */
	observePersistentWindow(
		input: {
			sessionId: string;
			startedAt: number;
			keepAliveMs: number;
		},
		now = new Date(),
	): void {
		this.ensureSchema();
		const seenAt = now.getTime();
		this.runner.sql`
			INSERT INTO browser_session_windows
				(session_id, started_at, last_seen_at, keep_alive_ms, ended_at)
			VALUES (
				${input.sessionId}, ${input.startedAt}, ${seenAt},
				${input.keepAliveMs}, NULL
			)
			ON CONFLICT(session_id) DO UPDATE SET
				last_seen_at = MAX(last_seen_at, excluded.last_seen_at)
		`;
		this.runner.sql`
			UPDATE browser_session_windows
			SET ended_at = last_seen_at + keep_alive_ms
			WHERE ended_at IS NULL AND last_seen_at + keep_alive_ms <= ${seenAt}
		`;
		const dayStart = Date.parse(`${browserBudgetDay(now)}T00:00:00.000Z`);
		this.runner.sql`
			DELETE FROM browser_session_windows
			WHERE ended_at IS NOT NULL AND ended_at < ${dayStart}
		`;
	}

	/** An explicit close ends the observed lifetime, capped at idle expiry. */
	endPersistentWindow(sessionId: string, now = new Date()): void {
		this.ensureSchema();
		this.runner.sql`
			UPDATE browser_session_windows
			SET ended_at = MIN(${now.getTime()}, last_seen_at + keep_alive_ms)
			WHERE session_id = ${sessionId} AND ended_at IS NULL
		`;
	}

	/**
	 * Observed lifetime in `now`'s UTC day, rounded up per session to minutes.
	 * The idle tail ends at last activity plus keep-alive, or an earlier close.
	 */
	persistentMinutes(now = new Date()): {
		day: string;
		minutes: number;
		ms: number;
	} {
		this.ensureSchema();
		const day = browserBudgetDay(now);
		const dayStart = Date.parse(`${day}T00:00:00.000Z`);
		const dayEnd = dayStart + 86_400_000;
		const ts = now.getTime();
		const rows = this.runner.sql<{
			started_at: number;
			last_seen_at: number;
			keep_alive_ms: number;
			ended_at: number | null;
		}>`
			SELECT started_at, last_seen_at, keep_alive_ms, ended_at
			FROM browser_session_windows
		`;
		let ms = 0;
		let minutes = 0;
		for (const row of rows) {
			const end =
				row.ended_at ?? Math.min(ts, row.last_seen_at + row.keep_alive_ms);
			const window = Math.min(end, dayEnd) - Math.max(row.started_at, dayStart);
			if (window <= 0) continue;
			ms += window;
			minutes += Math.ceil(window / 60_000);
		}
		return { day, minutes, ms };
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
