/**
 * DO-side skill guidance store.
 *
 * Caches the compact skill guidance block (one-line-per-skill summary list)
 * injected into the system prompt for progressive disclosure on every isolate
 * turn. Mirrors the pattern from `brain-digest-store-do.ts`.
 *
 * The full skill content is fetched on-demand by the native `read_skill` tool
 * (not stored here). Only the compact discovery block is cached so the model
 * can decide which skills are relevant before spending tokens on a full read.
 *
 * Freshness: the cached block is served immediately and refreshed PER TURN in
 * the background ({@link SkillGuidanceTurnGate}); `onRefreshSkillGuidance()`
 * remains as a 4-hour warmer for a DO that is otherwise idle. Before that, a
 * skill a tedi recorded could stay invisible to it for up to four hours, which
 * is the self-improvement flywheel refusing to close.
 *
 * Schema (created lazily on first call):
 *   skill_guidance(id PRIMARY KEY, guidance_text, updated_at)
 */

import { SKILL_RETRIEVAL_LIFECYCLE_PRIORITY } from "@tedix/context-core/skill-retrieval";
import type { DoSqlRunner } from "./brain-bridge-do";

interface GuidanceRow {
	guidance_text: string;
	updated_at: number;
}

const GUIDANCE_ROW_ID = "current";

/**
 * How long an EMPTY catalog is believed before the gate pays for another
 * lookup. Bounded, not for-the-object's-lifetime: the tedi that most needs the
 * flywheel to close is exactly the one with no skills yet, and a lifetime
 * negative cache would make its FIRST recorded skill invisible until the DO
 * evicted. Ten minutes keeps the empty case off the per-turn path (the common
 * case for a young tedi) while bounding the wait for that first skill.
 */
export const SKILL_GUIDANCE_EMPTY_TTL_MS = 10 * 60 * 1000;

/** Hard cap on advertised skills — see `selectGuidanceSkills`. */
export const SKILL_GUIDANCE_MAX_ENTRIES = 10;

/**
 * Choose which skills the guidance wall may advertise.
 *
 * Two gates, both load-bearing:
 *
 * 1. Tedi-owned only. `skills/listByOrg` returns the whole org catalog;
 *    injecting that wall into every turn measurably degraded task performance
 *    (controls that passed 12/12 pre-deploy dropped to 1/4 with the unscoped
 *    block). Org skills stay reachable on demand via `read_skill` by slug.
 *
 * 2. INJECTABLE LIFECYCLES ONLY. The platform read passes no `lifecycleState`,
 *    and that default excludes drafts but NOT `archived` or `stale`. So this
 *    wall could advertise skills the retrieval path deliberately refuses to
 *    inject, steering a tedi at an ARCHIVED skill swept for zero usage.
 *
 * Gate 2 reuses `SKILL_RETRIEVAL_LIFECYCLE_PRIORITY`, the same map
 * `buildRetrievalCorpus` uses, so "states that may steer a turn" is defined
 * once rather than duplicated per surface.
 *
 * Pure — exported so the guidance rules are tested directly instead of being
 * reproduced inline by a test that could drift from the DO.
 */
export function selectGuidanceSkills<
	T extends { tediId?: string | null; lifecycleState?: string | null },
>(entries: readonly T[], tediId: string): T[] {
	return entries
		.filter(
			(entry) =>
				entry.tediId === tediId &&
				SKILL_RETRIEVAL_LIFECYCLE_PRIORITY[entry.lifecycleState ?? ""] !==
					undefined,
		)
		.slice(0, SKILL_GUIDANCE_MAX_ENTRIES);
}

/**
 * Decides, once per turn, what the guidance block costs.
 *
 * The catalog used to refresh only on the 4-hour scheduled task, so a tedi that
 * recorded a skill could not see it for up to four hours. Refreshing per turn
 * fixes that, but the refresh is a platform round trip (`listSkillsForTedi`) —
 * awaiting it on every turn would put a blocking RPC in front of every single
 * turn. So:
 *
 * - **Warm cache → serve it and refresh behind the turn.** The turn pays
 *   nothing; the rebuilt block lands before the next turn reads it. A skill
 *   recorded during a session is therefore visible on the following turn
 *   instead of four hours later. Only one refresh is ever in flight.
 * - **Cold cache → build blocking, exactly as before.** Cold-start latency is
 *   unchanged; the first turn is not left skill-blind.
 * - **Empty catalog → remember that** for {@link SKILL_GUIDANCE_EMPTY_TTL_MS}.
 *   This is strictly cheaper than the previous behaviour, where an empty block
 *   was falsy and so re-ran the full build on EVERY turn.
 *
 * Effect-free and injected, so the whole policy is testable without a DO.
 */
export class SkillGuidanceTurnGate {
	private readonly build: () => Promise<string>;
	private readonly background: (task: Promise<unknown>) => void;
	private readonly now: () => number;
	private emptyUntilMs = 0;
	private inFlight: Promise<string> | null = null;

	constructor(options: {
		/** Rebuild the block from the platform and persist it. Must not throw. */
		build: () => Promise<string>;
		/** Keep a non-blocking refresh alive past the response (`ctx.waitUntil`). */
		background: (task: Promise<unknown>) => void;
		now?: () => number;
	}) {
		this.build = options.build;
		this.background = options.background;
		this.now = options.now ?? Date.now;
	}

	/**
	 * The guidance text for this turn, given whatever is currently cached.
	 * Never throws: a failed refresh degrades to the cached (or empty) block.
	 */
	async textForTurn(cachedText: string): Promise<string> {
		if (cachedText) {
			this.refreshBehindTurn();
			return cachedText;
		}
		if (this.now() < this.emptyUntilMs) return "";
		const text = await this.build().catch(() => "");
		if (!text) this.emptyUntilMs = this.now() + SKILL_GUIDANCE_EMPTY_TTL_MS;
		return text;
	}

	/** Drop the negative cache — the next turn pays for a real lookup again. */
	invalidateEmpty(): void {
		this.emptyUntilMs = 0;
	}

	private refreshBehindTurn(): void {
		if (this.inFlight) return;
		const task = this.build().catch(() => "");
		this.inFlight = task;
		this.background(
			task.finally(() => {
				this.inFlight = null;
			}),
		);
	}
}

export interface SkillGuidanceCacheEntry {
	text: string;
	updatedAt: number;
}

export class DoSkillGuidanceStore {
	private readonly runner: DoSqlRunner;
	private schemaReady = false;

	constructor(runner: DoSqlRunner) {
		this.runner = runner;
	}

	private ensureSchema(): void {
		if (this.schemaReady) return;
		this.runner.sql`
			CREATE TABLE IF NOT EXISTS skill_guidance (
				id TEXT PRIMARY KEY,
				guidance_text TEXT NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`;
		this.schemaReady = true;
	}

	/** Load the cached guidance text, or null if none has been written yet. */
	load(): SkillGuidanceCacheEntry | null {
		this.ensureSchema();
		const rows = this.runner.sql<GuidanceRow>`
			SELECT guidance_text, updated_at FROM skill_guidance WHERE id = ${GUIDANCE_ROW_ID}
		`;
		const row = rows[0];
		if (!row) return null;
		return { text: row.guidance_text, updatedAt: row.updated_at };
	}

	/** Full-replace the single canonical guidance row. */
	save(text: string): void {
		this.ensureSchema();
		const now = Date.now();
		this.runner.sql`
			INSERT INTO skill_guidance (id, guidance_text, updated_at)
			VALUES (${GUIDANCE_ROW_ID}, ${text}, ${now})
			ON CONFLICT(id) DO UPDATE SET
				guidance_text = excluded.guidance_text,
				updated_at = excluded.updated_at
		`;
	}

	/**
	 * Refresh only `updated_at` on the existing row. Used by the rebuild path
	 * when the freshly rendered guidance is byte-identical to the cached row
	 * (fingerprint gate): the row stays provably fresh without rewriting the
	 * text. No-op when no row exists yet.
	 */
	touch(): void {
		this.ensureSchema();
		const now = Date.now();
		this.runner.sql`
			UPDATE skill_guidance SET updated_at = ${now} WHERE id = ${GUIDANCE_ROW_ID}
		`;
	}
}
