/**
 * DO-side BrainDigest store.
 *
 * Mirrors `directive-store-do.ts` / `crystallization-store-do.ts`. Container
 * tedis persist the compiled brain digest to `memory/brain-digest.md` on the
 * workspace dir (tedix-context `persistBrainDigest`); isolate tedis persist it
 * to DO SQLite. The digest is a single cached `BrainDigest` (top-K memory
 * summary) injected every turn in "stable retrieval mode".
 *
 * Single-row store: the digest is full-replaced on each compile, so we keep one
 * canonical row keyed by a constant id and overwrite it. The `BrainDigest`
 * shape is owned by `brain/brain-digest.ts` and stored as an opaque
 * JSON blob — the store never queries by field.
 *
 * Schema (created lazily on first call):
 *   brain_digest(id PRIMARY KEY, digest_json, updated_at)
 */

import type { BrainDigest } from "./brain/brain-digest";
import type { DoSqlRunner } from "./brain-bridge-do";

interface DigestRow {
	digest_json: string;
}

const DIGEST_ROW_ID = "current";

export class DoBrainDigestStore {
	private readonly runner: DoSqlRunner;
	private schemaReady = false;

	constructor(runner: DoSqlRunner) {
		this.runner = runner;
	}

	private ensureSchema(): void {
		if (this.schemaReady) return;
		this.runner.sql`
			CREATE TABLE IF NOT EXISTS brain_digest (
				id TEXT PRIMARY KEY,
				digest_json TEXT NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`;
		this.schemaReady = true;
	}

	/** Load the cached digest, or null if none has been compiled yet. */
	async load(): Promise<BrainDigest | null> {
		this.ensureSchema();
		const rows = this.runner.sql<DigestRow>`
			SELECT digest_json FROM brain_digest WHERE id = ${DIGEST_ROW_ID}
		`;
		const row = rows[0];
		if (!row) return null;
		try {
			return JSON.parse(row.digest_json) as BrainDigest;
		} catch {
			return null;
		}
	}

	/** Full-replace the single canonical digest row. */
	async save(digest: BrainDigest): Promise<void> {
		this.ensureSchema();
		this.runner.sql`
			INSERT INTO brain_digest (id, digest_json, updated_at)
			VALUES (${DIGEST_ROW_ID}, ${JSON.stringify(digest)}, ${Date.now()})
			ON CONFLICT(id) DO UPDATE SET
				digest_json = excluded.digest_json,
				updated_at = excluded.updated_at
		`;
	}
}
