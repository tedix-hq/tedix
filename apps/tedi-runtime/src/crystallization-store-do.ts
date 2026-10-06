/**
 * DO-side CrystallizationStateStore implementation.
 *
 * The Agent runtime injects this DO SQLite store into runCrystallization.
 * The CrystallizationStateStore interface keeps pattern processing independent
 * of the runtime's persistence implementation.
 *
 * Schema (created lazily on first call):
 *   crystallization_patterns(pattern_key PRIMARY KEY, muscle_id, version,
 *     crystallized_at, observation_count)
 *
 * Eviction: cap stored patterns and best-effort delete the oldest rows when the
 * cap is breached. Crystallized patterns are append-mostly (one row per distinct
 * procedural pattern the tedi has ever crystallized), so the cap is generous.
 */

import type { CrystallizationStateStore } from "./brain/crystallizer";
import type { CrystallizationState } from "@tedix/context-core/crystallizer";
import type { Observation } from "@tedix/context-core/types";
import type { DoSqlRunner } from "./brain-bridge-do";

interface PatternRow {
	pattern_key: string;
	muscle_id: string;
	version: number;
	crystallized_at: string;
	observation_count: number;
}

interface BufferRow {
	obs_json: string;
}

export class DoCrystallizationStateStore implements CrystallizationStateStore {
	private readonly runner: DoSqlRunner;
	private readonly maxPatterns: number;
	private readonly evictCount: number;
	private readonly maxBuffer: number;
	private schemaReady = false;

	constructor(
		runner: DoSqlRunner,
		options: {
			maxPatterns?: number;
			evictCount?: number;
			maxBuffer?: number;
		} = {},
	) {
		this.runner = runner;
		this.maxPatterns = options.maxPatterns ?? 2000;
		this.evictCount = options.evictCount ?? 400;
		// ~ a container observe window's worth of procedural observations.
		this.maxBuffer = options.maxBuffer ?? 300;
	}

	private ensureSchema(): void {
		if (this.schemaReady) return;
		this.runner.sql`
			CREATE TABLE IF NOT EXISTS crystallization_patterns (
				pattern_key TEXT PRIMARY KEY,
				muscle_id TEXT NOT NULL,
				version INTEGER NOT NULL,
				crystallized_at TEXT NOT NULL,
				observation_count INTEGER NOT NULL
			)
		`;
		// Rolling buffer of recent PROCEDURAL observations. Crystallization
		// clusters within the observation set it is handed, and a single isolate
		// turn rarely yields 3+ same-pattern procedural observations — the
		// container accumulates them across its 15k-token observe window. This
		// buffer replays that accumulation so a pattern recurring across turns
		// reaches CRYSTALLIZATION_THRESHOLD.
		this.runner.sql`
			CREATE TABLE IF NOT EXISTS crystallization_obs_buffer (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				obs_json TEXT NOT NULL,
				created_at INTEGER NOT NULL
			)
		`;
		this.schemaReady = true;
	}

	/**
	 * Append this turn's PROCEDURAL observations to the rolling buffer, then
	 * trim to the most recent {@link maxBuffer}. Non-procedural observations are
	 * ignored — only procedural ones feed crystallization.
	 */
	bufferObservations(observations: Observation[], now: number): void {
		this.ensureSchema();
		const procedural = observations.filter((o) => o.type === "procedural");
		if (procedural.length === 0) return;
		for (const obs of procedural) {
			this.runner.sql`
				INSERT INTO crystallization_obs_buffer (obs_json, created_at)
				VALUES (${JSON.stringify(obs)}, ${now})
			`;
		}
		// Trim oldest rows beyond the window.
		const countRows = this.runner.sql<{ c: number }>`
			SELECT COUNT(*) AS c FROM crystallization_obs_buffer
		`;
		const count = countRows[0]?.c ?? 0;
		if (count > this.maxBuffer) {
			const drop = count - this.maxBuffer;
			this.runner.sql`
				DELETE FROM crystallization_obs_buffer
				WHERE id IN (
					SELECT id FROM crystallization_obs_buffer
					ORDER BY id ASC
					LIMIT ${drop}
				)
			`;
		}
	}

	/** Load the buffered procedural observations (oldest → newest). */
	loadBufferedObservations(): Observation[] {
		this.ensureSchema();
		const rows = this.runner.sql<BufferRow>`
			SELECT obs_json FROM crystallization_obs_buffer ORDER BY id ASC
		`;
		const out: Observation[] = [];
		for (const r of rows) {
			try {
				out.push(JSON.parse(r.obs_json) as Observation);
			} catch {
				/* skip corrupt row */
			}
		}
		return out;
	}

	async load(): Promise<CrystallizationState> {
		this.ensureSchema();
		const rows = this.runner.sql<PatternRow>`
			SELECT pattern_key, muscle_id, version, crystallized_at, observation_count
			FROM crystallization_patterns
		`;
		const patterns: CrystallizationState["patterns"] = {};
		for (const r of rows) {
			patterns[r.pattern_key] = {
				muscleId: r.muscle_id,
				version: r.version,
				crystallizedAt: r.crystallized_at,
				observationCount: r.observation_count,
			};
		}
		return { patterns };
	}

	async save(state: CrystallizationState): Promise<void> {
		this.ensureSchema();
		// Full-replace pattern: the crystallizer owns canonical state per run.
		// DO storage is local + fast; this stays cheap at our row counts.
		this.runner.sql`DELETE FROM crystallization_patterns`;
		for (const [key, p] of Object.entries(state.patterns)) {
			this.runner.sql`
				INSERT INTO crystallization_patterns
					(pattern_key, muscle_id, version, crystallized_at, observation_count)
				VALUES
					(${key}, ${p.muscleId}, ${p.version}, ${p.crystallizedAt}, ${p.observationCount})
			`;
		}

		// Safety-net eviction (the crystallizer adds at most one pattern per
		// distinct procedural cluster per turn; guard the table regardless).
		const countRows = this.runner.sql<{ c: number }>`
			SELECT COUNT(*) AS c FROM crystallization_patterns
		`;
		const count = countRows[0]?.c ?? 0;
		if (count > this.maxPatterns) {
			this.runner.sql`
				DELETE FROM crystallization_patterns
				WHERE pattern_key IN (
					SELECT pattern_key FROM crystallization_patterns
					ORDER BY crystallized_at ASC
					LIMIT ${this.evictCount}
				)
			`;
		}
	}
}
