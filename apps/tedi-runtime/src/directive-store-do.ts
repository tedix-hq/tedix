/**
 * DO-side DirectiveStore implementation.
 *
 * The Agent runtime persists compiled directives in DO SQLite through the
 * runtime-neutral DirectiveStore interface (load/save of CompiledDirective[]).
 * The runtime saves compileDirectives results here and injects this store into
 * runRationaleBridge for invalidation.
 *
 * Directives are stored as opaque JSON blobs (one row each) rather than a
 * normalized schema: the `CompiledDirective` shape is owned by
 * `@tedix/context-core` and may evolve, and the store never queries by field —
 * the compiler/invalidator operate on the in-memory array.
 *
 * Schema (created lazily on first call):
 *   compiled_directives(id PRIMARY KEY, directive_json, created_at)
 */

import type { DirectiveStore } from "./brain/rationale-bridge";
import type { CompiledDirective } from "@tedix/context-core/compiler";
import type { DoSqlRunner } from "./brain-bridge-do";

interface DirectiveRow {
	id: string;
	directive_json: string;
}

export class DoDirectiveStore implements DirectiveStore {
	private readonly runner: DoSqlRunner;
	private readonly maxDirectives: number;
	private schemaReady = false;

	constructor(runner: DoSqlRunner, options: { maxDirectives?: number } = {}) {
		this.runner = runner;
		this.maxDirectives = options.maxDirectives ?? 500;
	}

	private ensureSchema(): void {
		if (this.schemaReady) return;
		this.runner.sql`
			CREATE TABLE IF NOT EXISTS compiled_directives (
				id TEXT PRIMARY KEY,
				directive_json TEXT NOT NULL,
				created_at INTEGER NOT NULL
			)
		`;
		this.schemaReady = true;
	}

	/** Stable id for a directive — category + provenance keeps dedupe correct. */
	private directiveId(d: CompiledDirective, index: number): string {
		const cat = (d as { category?: string }).category ?? "uncategorized";
		const prov = (d as { provenanceHash?: string }).provenanceHash ?? index;
		return `${cat}:${prov}`;
	}

	async load(): Promise<CompiledDirective[]> {
		this.ensureSchema();
		const rows = this.runner.sql<DirectiveRow>`
			SELECT id, directive_json FROM compiled_directives ORDER BY created_at ASC
		`;
		const out: CompiledDirective[] = [];
		for (const r of rows) {
			try {
				out.push(JSON.parse(r.directive_json) as CompiledDirective);
			} catch {
				/* skip corrupt row */
			}
		}
		return out;
	}

	async save(directives: CompiledDirective[]): Promise<void> {
		this.ensureSchema();
		// Full-replace: the compiler / invalidator own the canonical set.
		this.runner.sql`DELETE FROM compiled_directives`;
		const now = Date.now();
		const capped = directives.slice(0, this.maxDirectives);
		capped.forEach((d, i) => {
			this.runner.sql`
				INSERT INTO compiled_directives (id, directive_json, created_at)
				VALUES (${this.directiveId(d, i)}, ${JSON.stringify(d)}, ${now})
			`;
		});
	}

	/**
	 * Re-persist the JSON blob for a subset of directives in place, keyed by
	 * the stable `directiveId`. Used by the per-turn selective-matching path to
	 * persist `lastMatchedAt` updates WITHOUT a full DELETE/INSERT churn of the
	 * whole table (the common case is 1–2 matched directives per turn).
	 *
	 * `created_at` is preserved (we only UPDATE the blob); rows whose id is not
	 * already present are skipped — the canonical set is owned by `save`.
	 * Pass the directive's original index so the id matches the row written by
	 * `save` (which used array position for provenance-less directives).
	 */
	async updateLastMatched(
		updates: Array<{ directive: CompiledDirective; index: number }>,
	): Promise<void> {
		if (updates.length === 0) return;
		this.ensureSchema();
		for (const { directive, index } of updates) {
			this.runner.sql`
				UPDATE compiled_directives
				SET directive_json = ${JSON.stringify(directive)}
				WHERE id = ${this.directiveId(directive, index)}
			`;
		}
	}

	/**
	 * Persist a post-turn INFLUENCE update (recalibrated `successRate`) for a
	 * subset of directives, keyed by the stable `directiveId`. Identical
	 * mechanism to {@link updateLastMatched} (in-place blob UPDATE, no full-table
	 * churn) — the caller has already applied `recordDirectiveInfluence` to the
	 * in-memory blob, so this just re-serializes it. Rows whose id is not already
	 * present are skipped; the canonical set is owned by `save`. `created_at` is
	 * preserved, so influence updates never disturb stale-prune ordering.
	 */
	async recordInfluence(
		updates: Array<{ directive: CompiledDirective; index: number }>,
	): Promise<void> {
		if (updates.length === 0) return;
		this.ensureSchema();
		for (const { directive, index } of updates) {
			this.runner.sql`
				UPDATE compiled_directives
				SET directive_json = ${JSON.stringify(directive)}
				WHERE id = ${this.directiveId(directive, index)}
			`;
		}
	}
}
