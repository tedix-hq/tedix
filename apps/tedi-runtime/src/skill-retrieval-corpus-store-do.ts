/**
 * DO-side act-time skill-retrieval corpus store.
 *
 * Caches the compact org-readable skill corpus that `retrievedSkillsAddendum`
 * (do.ts) matches against each turn's user text — the AWM/Memp "retrieve" leg.
 * Mirrors the pattern from `skill-guidance-store-do.ts`: one canonical row in
 * DO SQLite, refreshed on the same 4-hour `onRefreshSkillGuidance` cadence
 * (both projections come from the SAME `listSkillsForTedi` platform read).
 *
 * The corpus deliberately differs from the skill-guidance block's population:
 * guidance advertises the tedi's OWN skills (any lifecycle) as one-line
 * summaries; the retrieval corpus holds every skill the tedi can READ —
 * including org-scoped mined workflows (`tediId` null), the Davenport
 * "localness" fix — but only lifecycle states past the execute-to-promote
 * gate (active/proven/crystallized; never drafts). Selection happens per turn
 * in `@tedix/context-core/skill-retrieval` — cached corpus, zero per-turn RPC.
 *
 * Schema (created lazily on first call):
 *   skill_retrieval_corpus(id PRIMARY KEY, corpus_json, updated_at)
 */

import type { SkillSearchEntry } from "./brain/platform-client";
import {
	type RetrievableSkill,
	SKILL_RETRIEVAL_DEFAULT_MIN_OVERLAP,
	SKILL_RETRIEVAL_DEFAULT_TOP_K,
	SKILL_RETRIEVAL_LIFECYCLE_PRIORITY,
	SKILL_RETRIEVAL_MAX_TOP_K,
} from "@tedix/context-core/skill-retrieval";
import type { DoSqlRunner } from "./brain-bridge-do";

interface CorpusRow {
	corpus_json: string;
	updated_at: number;
}

const CORPUS_ROW_ID = "current";

/** Max skills persisted in the corpus (matches the platform fetch cap). */
export const SKILL_RETRIEVAL_CORPUS_MAX_SKILLS = 50;

/**
 * Per-skill stored-content cap (chars). Keeps the single corpus row bounded
 * (~50 × 2.5KB); the render-time token cap trims further.
 */
export const SKILL_RETRIEVAL_CORPUS_MAX_CONTENT_CHARS = 2500;

export interface SkillRetrievalCorpusEntry {
	skills: RetrievableSkill[];
	updatedAt: number;
}

/**
 * Project org-readable skill rows into the persisted retrieval corpus:
 * injectable lifecycles only (never drafts), compact fields, capped content.
 * Pure — exported for offline tests.
 */
export function buildRetrievalCorpus(
	entries: SkillSearchEntry[],
): RetrievableSkill[] {
	const corpus: RetrievableSkill[] = [];
	for (const entry of entries) {
		if (
			SKILL_RETRIEVAL_LIFECYCLE_PRIORITY[entry.lifecycleState ?? ""] ===
			undefined
		) {
			continue;
		}
		corpus.push({
			id: entry.id,
			slug: entry.slug ?? null,
			title: entry.title,
			summary: entry.summary ?? null,
			description: entry.description ?? null,
			tags: entry.tags ?? null,
			toolIds: entry.toolIds ?? null,
			lifecycleState: entry.lifecycleState ?? null,
			successCount: entry.successCount ?? null,
			failureCount: entry.failureCount ?? null,
			lastUsedAt: entry.lastUsedAt ?? null,
			content:
				entry.content?.slice(0, SKILL_RETRIEVAL_CORPUS_MAX_CONTENT_CHARS) ??
				null,
			preconditions: entry.preconditions?.notWhen
				? { notWhen: entry.preconditions.notWhen }
				: null,
		});
		if (corpus.length >= SKILL_RETRIEVAL_CORPUS_MAX_SKILLS) break;
	}
	return corpus;
}

/**
 * Parse the act-time retrieval knobs from Worker vars (`wrangler.jsonc`
 * `vars` is the sanctioned non-secret config surface; no new control-plane
 * plumbing). Fail-soft: anything unparseable falls back to the defaults.
 * `TEDI_SKILL_RETRIEVAL_TOP_K=0` is the kill switch.
 */
export function parseSkillRetrievalKnobs(env: {
	TEDI_SKILL_RETRIEVAL_TOP_K?: string;
	TEDI_SKILL_RETRIEVAL_MIN_OVERLAP?: string;
}): { topK: number; minOverlap: number } {
	const rawTopK = Number.parseInt(env.TEDI_SKILL_RETRIEVAL_TOP_K ?? "", 10);
	const topK = Number.isNaN(rawTopK)
		? SKILL_RETRIEVAL_DEFAULT_TOP_K
		: Math.min(Math.max(rawTopK, 0), SKILL_RETRIEVAL_MAX_TOP_K);
	const rawFloor = Number.parseInt(
		env.TEDI_SKILL_RETRIEVAL_MIN_OVERLAP ?? "",
		10,
	);
	const minOverlap = Number.isNaN(rawFloor)
		? SKILL_RETRIEVAL_DEFAULT_MIN_OVERLAP
		: Math.max(rawFloor, 1);
	return { topK, minOverlap };
}

export class DoSkillRetrievalCorpusStore {
	private readonly runner: DoSqlRunner;
	private schemaReady = false;

	constructor(runner: DoSqlRunner) {
		this.runner = runner;
	}

	private ensureSchema(): void {
		if (this.schemaReady) return;
		this.runner.sql`
			CREATE TABLE IF NOT EXISTS skill_retrieval_corpus (
				id TEXT PRIMARY KEY,
				corpus_json TEXT NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`;
		this.schemaReady = true;
	}

	/** Load the cached corpus, or null if none has been written / JSON is bad. */
	load(): SkillRetrievalCorpusEntry | null {
		this.ensureSchema();
		const rows = this.runner.sql<CorpusRow>`
			SELECT corpus_json, updated_at FROM skill_retrieval_corpus WHERE id = ${CORPUS_ROW_ID}
		`;
		const row = rows[0];
		if (!row) return null;
		try {
			const skills = JSON.parse(row.corpus_json) as RetrievableSkill[];
			if (!Array.isArray(skills)) return null;
			return { skills, updatedAt: row.updated_at };
		} catch {
			return null;
		}
	}

	/** Full-replace the single canonical corpus row. */
	save(skills: RetrievableSkill[]): void {
		this.ensureSchema();
		const now = Date.now();
		const json = JSON.stringify(skills);
		this.runner.sql`
			INSERT INTO skill_retrieval_corpus (id, corpus_json, updated_at)
			VALUES (${CORPUS_ROW_ID}, ${json}, ${now})
			ON CONFLICT(id) DO UPDATE SET
				corpus_json = excluded.corpus_json,
				updated_at = excluded.updated_at
		`;
	}
}
