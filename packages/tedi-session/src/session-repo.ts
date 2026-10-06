/**
 * Append-only DO-SQLite session backend for the Agent runtime.
 * SessionHarness builds ledger-first context over this cache; the canonical
 * transcript remains in D1. SQL and durable reads are injected through
 * SessionRepoDeps, without Cloudflare runtime types.
 *
 * Message rows carry deterministic idempotency keys. Branch walking supports
 * non-destructive compaction: appended markers change the read projection,
 * while original messages remain stored.
 */

import { selectRetainIndex } from "@tedix/context-core/compaction-boundary";
import { countTokens } from "@tedix/context-core/tokens";
import {
	projectDurableCompaction,
	type SessionHarnessBackend,
	type TediSessionCompactionResult,
	type TediSessionCompactOptions,
	type TediSessionContextEntry,
	type TediSessionDurableState,
	type TediSessionModelIdentity,
	type TediSessionReplayCheckpoint,
	type TediSessionSummarizer,
	type TediSessionTurn,
} from "./session-harness";

/** Default recent-window cap — mirrors `do.ts` `MAX_RECENT_TURNS = 40`. */
const DEFAULT_MAX_RECENT_TURNS = 40;

/**
 * Default keep-recent-token budget for compaction — the suffix `compactSession`
 * protects (never summarizes). The head before this budget is collapsed into
 * the summary; the tail at/after the cut is kept verbatim. Tests inject a small
 * value to exercise the cut.
 */
export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;

/**
 * DO-SQLite tagged-template runner port. Mirrors the exact call convention of the
 * DO's `this.sql` (see `DoSqlRunner` in `brain-bridge-do.ts` and the `getSqlRunner`
 * shim in `do.ts:695`): a tagged template that returns the result rows directly as
 * `T[]` (synchronous DO-SQLite exec). The integrator passes `this.sql` (or the
 * `getSqlRunner().sql` shim) straight in.
 */
export type SessionRepoSql = <T = Record<string, unknown>>(
	strings: TemplateStringsArray,
	...values: (string | number | boolean | null)[]
) => T[];

export interface SessionRepoDeps {
	/** DO-SQLite tagged-template runner — same shape as the DO's `this.sql`. */
	sql: SessionRepoSql;
	/**
	 * The durable, canonical per-conversation transcript read — the existing
	 * `do.ts` `readDurableMessagesForSession`, passed in verbatim. The ledger
	 * stays canonical; `buildContext` stays ledger-first. This repo never writes
	 * to or owns the durable transcript.
	 */
	readDurable: (
		sessionKey: string,
		limit?: number,
	) => Promise<TediSessionDurableState>;
	/** Recent-window cap. Default 40 (matches `MAX_RECENT_TURNS`). */
	maxRecentTurns?: number;
	/**
	 * Compaction keep-recent-token budget: the verbatim suffix protected by
	 * `compactSession`. Defaults to {@link DEFAULT_KEEP_RECENT_TOKENS}.
	 */
	keepRecentTokens?: number;
}

/** Raw message-row projection from `session_entries`. */
interface SessionEntryRow {
	session_key: string;
	role: string;
	content: string;
	ts: number;
	model_provider: string | null;
	model_id: string | null;
}

/** Stored entry types used by branch projection and append-only compaction. */
export type SessionEntryType = "message" | "compaction" | "branch_summary";

/**
 * Full phase-2 entry view (vs the phase-1 message-only {@link SessionEntryRow}).
 * `compaction` rows store the summary in `content`, the cut boundary in
 * `firstKeptEntryId`, and the pre-compaction token estimate in `tokensBefore`
 * Message rows leave those undefined. `parentId` is the branch link (the prior entry in the same
 * conversation path); phase-1 rows wrote `parent_id = NULL`, so the branch walk
 * falls back to ts-ordering for pre-phase-2 history (see {@link pathToRoot}).
 */
export interface SessionEntry {
	id: string;
	sessionKey: string;
	parentId: string | null;
	type: SessionEntryType;
	role: "user" | "assistant";
	content: string;
	ts: number;
	/** `compaction` only — entry id where retained (non-summarized) history starts. */
	firstKeptEntryId?: string;
	/** `compaction` only — estimated context tokens before this compaction. */
	tokensBefore?: number;
	modelIdentity?: TediSessionModelIdentity;
}

/** Raw phase-2 row shape — the full column set including branch/compaction. */
interface FullEntryRow {
	id: string;
	session_key: string;
	parent_id: string | null;
	type: string;
	role: string;
	content: string;
	ts: number;
	first_kept_entry_id: string | null;
	tokens_before: number | null;
	model_provider: string | null;
	model_id: string | null;
}

/** Map a full phase-2 row to a {@link SessionEntry}. */
function rowToEntry(row: FullEntryRow): SessionEntry {
	const type: SessionEntryType =
		row.type === "compaction"
			? "compaction"
			: row.type === "branch_summary"
				? "branch_summary"
				: "message";
	return {
		id: row.id,
		sessionKey: row.session_key,
		parentId: row.parent_id,
		type,
		role: row.role === "assistant" ? "assistant" : "user",
		content: row.content,
		ts: row.ts,
		firstKeptEntryId: row.first_kept_entry_id ?? undefined,
		tokensBefore: row.tokens_before ?? undefined,
		...(row.model_provider && row.model_id
			? {
					modelIdentity: {
						provider: row.model_provider,
						model: row.model_id,
					},
				}
			: {}),
	};
}

// ── Pure, unit-testable decision functions ───────────────────────────────────

/**
 * Deterministic idempotency key from the ledger's `{runId}:{seq}` event-id scheme
 * (`ledger-mirror.ts`: user turn = seq 0, assistant turn = seq 2). Mirroring the
 * ledger's id derivation means the recent-turn cache dedups on exactly the same
 * boundary the ledger's conflict-do-nothing does, so a retried turn (workflow
 * resume, mesh redelivery) yields one row here just as it yields one ledger event.
 */
export function deriveIdempotencyKey(
	runId: string,
	role: "user" | "assistant",
): string {
	const seq = role === "user" ? 0 : 2;
	return `${runId}:${seq}`;
}

/**
 * Map a raw DB row to a body-neutral `TediSessionTurn`. The `sessionKey` is the
 * stored `session_key`; `ts` is the stored turn timestamp (the same timestamp the
 * ledger `createdAt` derives from — the stable join key `mergeDurableAndCache`
 * uses, see `session-harness.ts`).
 */
export function rowToTurn(row: SessionEntryRow): TediSessionTurn {
	return {
		role: row.role === "assistant" ? "assistant" : "user",
		content: row.content,
		sessionKey: row.session_key,
		ts: row.ts,
		...(row.model_provider && row.model_id
			? {
					modelIdentity: {
						provider: row.model_provider,
						model: row.model_id,
					},
				}
			: {}),
	};
}

/**
 * Bounded recent-window projection used by `listTurns()`. Given the
 * most-recent-first rows (as SELECT … ORDER BY ts DESC LIMIT max returns them),
 * reverse to ts-ascending so the harness's cache slice + ts-keyed merge see a
 * contiguous recent suffix — the exact `state.recentTurns` semantics they expect.
 * Pure so it is unit-testable offline.
 */
export function selectRecentWindow(
	rowsDesc: ReadonlyArray<SessionEntryRow>,
	max: number,
): TediSessionTurn[] {
	const capped = max > 0 ? rowsDesc.slice(0, max) : [...rowsDesc];
	// rows arrive ts-DESC (most recent first); reverse → ts-ASC contiguous suffix.
	return capped.map(rowToTurn).reverse();
}

/**
 * Stable, deterministic entry id when the caller does not supply one. Random/clock
 * id generation (`Math.random`/`Date.now`) is avoided as a codebase convention —
 * the turn's own `ts` + `sessionKey` + `role` are already the natural identity of a
 * message entry in the append-only log. (The unique idempotency index is the real
 * dedup guard; this id only needs to be PK-unique, which the triple is for distinct
 * turns.)
 */
export function deriveEntryId(turn: TediSessionTurn): string {
	return `${turn.sessionKey ?? ""}:${turn.ts}:${turn.role}`;
}

// ── Phase-2 pure functions: branch walk, compaction overlay, cut point ────────

/**
 * Conservative token estimate — 1 token is roughly 4 chars. The heuristic itself
 * lives once, in `@tedix/context-core/tokens`; this is the session-repo spelling
 * of it, not a second implementation.
 */
export const estimateTokens = countTokens;

async function sha256Fingerprint(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("")}`;
}

/** Build the first replay-complete slice from the exact compacted ledger span. */
export async function buildReplayCheckpoint(
	entries: ReadonlyArray<SessionEntry>,
	coveredThroughEntryId: string,
): Promise<TediSessionReplayCheckpoint> {
	const contextSources = await Promise.all(
		entries
			.filter((entry) => entry.type === "message")
			.map(async (entry) => ({
				id: entry.id,
				kind: "session_message",
				fingerprint: await sha256Fingerprint(
					JSON.stringify({
						id: entry.id,
						role: entry.role,
						content: entry.content,
						ts: entry.ts,
					}),
				),
			})),
	);
	const body = {
		version: 1 as const,
		coveredThroughEntryId,
		capabilityBindings: [],
		artifactRevisions: [],
		pendingApprovals: [],
		workReferences: [],
		toolResultDependencies: [],
		contextSources,
		truncated: false,
	};
	return {
		...body,
		checkpointDigest: await sha256Fingerprint(JSON.stringify(body)),
	};
}

/**
 * Walk a branch from `leafId` back to the root via `parentId`. Returns the path
 * root-first (ts-/append-ascending), the order `projectBranch` and the harness
 * expect.
 *
 * Robust to phase-1 history: rows written before phase-2 have `parentId = null`,
 * so a strict parent walk would stop at the first phase-1 row. When the walked
 * entry has no `parentId` but older same-session entries exist, we fall back to
 * the immediately-earlier entry by `ts` (the implicit linear chain phase-1
 * appended). This makes a mixed phase-1/phase-2 log walk as one contiguous
 * branch without a backfill migration. A missing/dangling `leafId` yields `[]`
 * (best-effort: never throw into a turn; the isolate degrades).
 */
export function pathToRoot(
	entries: ReadonlyArray<SessionEntry>,
	leafId: string,
): SessionEntry[] {
	const byId = new Map(entries.map((e) => [e.id, e]));
	const start = byId.get(leafId);
	if (!start) return [];
	// Same-session entries, ts-ascending — the fallback chain for null parentId.
	const sameSession = entries
		.filter((e) => e.sessionKey === start.sessionKey)
		.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
	const indexById = new Map(sameSession.map((e, i) => [e.id, i]));
	const path: SessionEntry[] = [];
	const seen = new Set<string>();
	let current: SessionEntry | undefined = start;
	while (current && !seen.has(current.id)) {
		seen.add(current.id);
		path.unshift(current);
		if (current.parentId) {
			current = byId.get(current.parentId);
			continue;
		}
		// No explicit parent (phase-1 row) → fall back to the prior ts-neighbour.
		const idx = indexById.get(current.id);
		current = idx != null && idx > 0 ? sameSession[idx - 1] : undefined;
	}
	return path;
}

/**
 * Read-time non-destructive compaction overlay. Given a branch (root-first), if it
 * contains a `compaction` entry, project: one synthetic summary message
 * (assistant role), then every entry at/after `firstKeptEntryId`, then any
 * entries after the compaction marker itself. Entries before `firstKeptEntryId`
 * are skipped at read time but remain on disk (a fork from an older leaf still
 * sees them — that is what makes this reversible). With no `compaction` entry the
 * branch projects 1:1 (so phase-1 behaviour is exactly preserved).
 *
 * The last compaction entry on the path wins (iterative re-compaction stacks;
 * the newest summary + cut supersedes older ones).
 */
export function projectBranch(
	entries: ReadonlyArray<SessionEntry>,
): TediSessionContextEntry[] {
	let compactionIdx = -1;
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		if (entries[i]!.type === "compaction") {
			compactionIdx = i;
			break;
		}
	}

	const toContext = (e: SessionEntry): TediSessionContextEntry => ({
		role: e.role,
		content: e.content,
		ts: e.ts,
	});

	if (compactionIdx < 0) {
		// No compaction → 1:1 projection of message entries (phase-1 view).
		return entries.filter((e) => e.type === "message").map(toContext);
	}

	const compaction = entries[compactionIdx]!;
	// Stamp the summary just before the first kept entry so the projected stream
	// stays ts-ascending and the summary leads the retained tail — `selectSessionContext`
	// preserves order and `mergeDurableAndCache` keys on the earliest ts, so the
	// summary must sort ahead of `firstKeptEntryId`. (1ms below the cut: ts are epoch
	// millis, so this never collides with a real turn and keeps the boundary monotonic.)
	const firstKept = entries.find(
		(e) => e.id === compaction.firstKeptEntryId && e.type === "message",
	);
	const summaryTs = firstKept ? firstKept.ts - 1 : compaction.ts;

	const out: TediSessionContextEntry[] = [];
	// 1) The synthetic summary message (assistant role), ahead of the kept tail.
	out.push({ role: "assistant", content: compaction.content, ts: summaryTs });

	// 2) Entries from `firstKeptEntryId` (inclusive) up to the compaction marker,
	//    skipping everything before the cut.
	let kept = false;
	for (let i = 0; i < compactionIdx; i += 1) {
		const e = entries[i]!;
		if (e.id === compaction.firstKeptEntryId) kept = true;
		if (kept && e.type === "message") out.push(toContext(e));
	}
	// 3) Everything appended after the compaction marker (the live tail).
	for (let i = compactionIdx + 1; i < entries.length; i += 1) {
		const e = entries[i]!;
		if (e.type === "message") out.push(toContext(e));
	}
	return out;
}

/**
 * Result of {@link TediSessionRepo.compactSession}. Returned (instead of `void`)
 * so callers can emit an observability signal when compaction actually ran — the
 * queued `onCompactSession` handler in `do.ts` turns a `{ compacted: true }`
 * result into one canonical `context.compacted` runtime event in
 * `tedi_runtime_events`. A no-op (head under the keep budget, empty branch, or a
 * null/blank summary from the port) returns `{ compacted: false }` (or `null`
 * when there was no session/branch at all), so the emitter stays silent and the
 * ledger only ever carries events for real cuts. Best-effort: any internal throw
 * still degrades to `{ compacted: false }` — compaction never throws into a turn.
 */
export type CompactionResult = TediSessionCompactionResult;

/** Result of {@link findCutPoint}. */
export interface CutPoint {
	/** Entry id of the first retained (non-summarized) entry, or null when there
	 * is nothing to compact (head smaller than the keep budget). */
	firstKeptId: string | null;
	/** Whether the chosen cut had to be snapped off an assistant entry onto an
	 * earlier user boundary (the simplified "never cut mid-tool-pair"). */
	isSplit: boolean;
}

/**
 * Choose the compaction cut: walk back from the tail accumulating estimated
 * tokens until the retained suffix reaches `keepRecentTokens`, then snap the cut
 * to a user-message boundary. The "never cut mid-tool-pair" rule collapses here
 * to "cut on a user entry", because phase-2 entries are only user/assistant
 * messages and a turn always starts with the user message. Snapping onto the
 * user that starts the assistant's turn keeps each kept turn intact.
 *
 * The walk and the snap are the shared `selectRetainIndex` in
 * `@tedix/context-core/compaction-boundary` (the kernel's replay projection runs
 * the same selection over char weights). What is repo-specific and stays here:
 * the token weight unit, filtering to `message` entries, and naming the cut by
 * entry ID rather than array index.
 *
 * Returns `firstKeptId = null` when the whole head fits under the keep budget
 * (nothing worth summarizing) — `compactSession` then no-ops.
 */
export function findCutPoint(
	entries: ReadonlyArray<SessionEntry>,
	keepRecentTokens: number,
): CutPoint {
	const msgs = entries.filter((e) => e.type === "message");
	const selected = selectRetainIndex(
		msgs.map((e) => ({ role: e.role, weight: estimateTokens(e.content) })),
		keepRecentTokens,
	);
	if (!selected) return { firstKeptId: null, isSplit: false };
	return {
		firstKeptId: msgs[selected.retainFrom]!.id,
		isSplit: selected.snapped,
	};
}

// ── The append-only SQL I/O shell ────────────────────────────────────────────

/**
 * Append-only `session_entries` backend. A thin SQL I/O shell — all decision
 * logic lives in the pure functions above. Lazy schema creation mirrors
 * `DoDedupStore.ensureSchema()`.
 */
export class TediSessionRepo implements SessionHarnessBackend {
	private readonly sql: SessionRepoSql;
	private readonly readDurable: SessionRepoDeps["readDurable"];
	private readonly maxRecentTurns: number;
	private readonly keepRecentTokens: number;
	private schemaReady = false;

	constructor(deps: SessionRepoDeps) {
		this.sql = deps.sql;
		this.readDurable = deps.readDurable;
		this.maxRecentTurns = deps.maxRecentTurns ?? DEFAULT_MAX_RECENT_TURNS;
		this.keepRecentTokens = deps.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS;
	}

	private ensureSchema(): void {
		if (this.schemaReady) return;
		// Base schema. Normal turns are `message` rows; compaction uses the
		// same append-only table with metadata columns added below.
		// `idempotency_key` is nullable: the partial unique index only constrains
		// keyed appends for ledger-mirrored turns.
		this.sql`
			CREATE TABLE IF NOT EXISTS session_entries (
				id TEXT PRIMARY KEY,
				session_key TEXT NOT NULL,
				parent_id TEXT,
				type TEXT NOT NULL DEFAULT 'message',
				role TEXT NOT NULL,
				content TEXT NOT NULL,
				idempotency_key TEXT,
				ts INTEGER NOT NULL
			)
		`;
		this.sql`
			CREATE INDEX IF NOT EXISTS idx_session_entries_key_ts
				ON session_entries (session_key, ts)
		`;
		this.sql`
			CREATE UNIQUE INDEX IF NOT EXISTS uq_session_entries_key_idem
				ON session_entries (session_key, idempotency_key)
				WHERE idempotency_key IS NOT NULL
		`;
		this.ensurePhase2Columns();
		this.schemaReady = true;
	}

	/**
	 * Phase-2 additive migration. The phase-1 `CREATE TABLE` above is left byte-
	 * identical (the concurrent do.ts integrator and the offline fake-sql matcher
	 * both pin those exact statements), so the compaction-metadata columns are
	 * added with idempotent `ALTER TABLE ADD COLUMN`. SQLite has no
	 * `ADD COLUMN IF NOT EXISTS`, and a re-add throws "duplicate column name" — so
	 * each ALTER is wrapped in try/catch: first run adds it, later runs no-op.
	 * Existing phase-1 rows get these columns as null (they are message rows;
	 * only `compaction` rows ever populate them). On a brand-new DB the columns
	 * are added here on first `ensureSchema` just the same.
	 */
	private ensurePhase2Columns(): void {
		this.tryAlter`
			ALTER TABLE session_entries ADD COLUMN first_kept_entry_id TEXT
		`;
		this.tryAlter`
			ALTER TABLE session_entries ADD COLUMN tokens_before INTEGER
		`;
		this.tryAlter`
			ALTER TABLE session_entries ADD COLUMN model_provider TEXT
		`;
		this.tryAlter`
			ALTER TABLE session_entries ADD COLUMN model_id TEXT
		`;
	}

	/** Run one `ALTER TABLE ADD COLUMN`, swallowing the duplicate-column error so
	 * the migration is idempotent across DOs that already ran it. */
	private tryAlter(
		strings: TemplateStringsArray,
		...values: (string | number | boolean | null)[]
	): void {
		try {
			this.sql(strings, ...values);
		} catch {
			// Column already exists (duplicate column name) — additive migration is
			// idempotent; nothing else can fail in an add column of a nullable column.
		}
	}

	// ── SessionHarnessBackend ──────────────────────────────────────────────────

	/**
	 * The full recent-turn cache across all conversations, ts-ascending, bounded to
	 * `maxRecentTurns`. The harness slices this per-session (`selectSessionContext`)
	 * and merges the durable transcript under it (`mergeDurableAndCache`). Bounding
	 * here preserves the `state.recentTurns` cap semantics the merge relies on (the
	 * cache is a contiguous recent suffix; older history back-fills from the ledger).
	 */
	listTurns(): ReadonlyArray<TediSessionTurn> {
		this.ensureSchema();
		// Phase-2: if any compaction entry exists, sessions with one must surface
		// the projected (overlay) view so the harness's ledger-first `buildContext`
		// shows the compacted history. When none exists this short-circuits to the
		// exact phase-1 read (same statement, same `selectRecentWindow`), so
		// phase-1 behaviour — and `mergeDurableAndCache` ts-boundary semantics — is
		// byte-for-byte preserved whenever nothing has been compacted.
		const compactedKeys = this.sessionsWithCompaction();
		if (compactedKeys.size === 0) {
			const rowsDesc = this.sql<SessionEntryRow>`
				SELECT session_key, role, content, ts, model_provider, model_id
				FROM session_entries
				WHERE type = 'message'
				ORDER BY ts DESC
				LIMIT ${this.maxRecentTurns}
			`;
			return selectRecentWindow(rowsDesc, this.maxRecentTurns);
		}
		return this.listTurnsProjected(compactedKeys);
	}

	/** Set of session keys that have at least one `compaction` entry. Empty ⇒
	 * the phase-1 fast path in `listTurns` (no projection needed). */
	private sessionsWithCompaction(): Set<string> {
		const rows = this.sql<{ session_key: string }>`
			SELECT DISTINCT session_key FROM session_entries WHERE type = 'compaction'
		`;
		return new Set(rows.map((r) => r.session_key));
	}

	/**
	 * Projected recent-window read for the case where ≥1 session is compacted.
	 * Compacted sessions are projected through {@link projectBranch} (summary +
	 * read-time skip); un-compacted sessions keep their raw message turns. The
	 * combined stream is then ts-ordered and bounded to `maxRecentTurns`, matching
	 * the phase-1 window contract `mergeDurableAndCache` relies on.
	 */
	private listTurnsProjected(compactedKeys: Set<string>): TediSessionTurn[] {
		const all = this.readAllEntries();
		const bySession = new Map<string, SessionEntry[]>();
		for (const e of all) {
			const list = bySession.get(e.sessionKey) ?? [];
			list.push(e);
			bySession.set(e.sessionKey, list);
		}
		const turns: TediSessionTurn[] = [];
		for (const [key, entries] of bySession) {
			if (compactedKeys.has(key)) {
				for (const ctx of projectBranch(entries)) {
					turns.push({
						role: ctx.role,
						content: ctx.content,
						sessionKey: key,
						ts: ctx.ts,
					});
				}
			} else {
				for (const e of entries) {
					if (e.type === "message") {
						turns.push({
							role: e.role,
							content: e.content,
							sessionKey: key,
							ts: e.ts,
							...(e.modelIdentity ? { modelIdentity: e.modelIdentity } : {}),
						});
					}
				}
			}
		}
		turns.sort((a, b) => a.ts - b.ts);
		return turns.length > this.maxRecentTurns
			? turns.slice(turns.length - this.maxRecentTurns)
			: turns;
	}

	/** Read all entries (full phase-2 column set), ts-ascending then id-stable. */
	private readAllEntries(sessionKey?: string): SessionEntry[] {
		const rows = sessionKey
			? this.sql<FullEntryRow>`
				SELECT id, session_key, parent_id, type, role, content, ts,
					first_kept_entry_id, tokens_before, model_provider, model_id
				FROM session_entries
				WHERE session_key = ${sessionKey}
				ORDER BY ts ASC
			`
			: this.sql<FullEntryRow>`
				SELECT id, session_key, parent_id, type, role, content, ts,
					first_kept_entry_id, tokens_before, model_provider, model_id
				FROM session_entries
				ORDER BY ts ASC
			`;
		return rows.map(rowToEntry);
	}

	/** {@link SessionHarnessBackend.appendTurn} — threads the harness-supplied
	 * `idempotencyKey` through to {@link appendTurnWithKey}. The pass-through is
	 * load-bearing: the harness calls `backend.appendTurn(turn, key)` with the
	 * ledger-derived `{runId}:{seq}` key, and the previous one-parameter
	 * implementation silently dropped it (structural typing accepts the narrower
	 * signature), so every harness-mediated append landed with
	 * `idempotency_key = NULL` and deduped only on the non-deterministic
	 * `${sessionKey}:${ts}:${role}` PK. With the key threaded, a retried turn
	 * (workflow resume, mesh redelivery) is a keyed no-op and the row is
	 * exact-readable via {@link findTurnByIdempotencyKey}. Key omitted ⇒
	 * PK-dedup only (unchanged). */
	appendTurn(turn: TediSessionTurn, idempotencyKey?: string): boolean {
		return this.appendTurnWithKey(turn, idempotencyKey);
	}

	/**
	 * Append a message entry, optionally deduped on a deterministic
	 * `idempotencyKey`. Callers with a runId-style key (the WS/mesh turn families
	 * in `do.ts` that already compute a `runId`, e.g. `commitAssistantTurn` /
	 * `beforeTurn`) pass `deriveIdempotencyKey(runId, role)` so a retried turn is
	 * inserted once — `INSERT OR IGNORE` on the partial UNIQUE
	 * `(session_key, idempotency_key)` index makes the second insert a no-op,
	 * mirroring the ledger's conflict-do-nothing. The base `appendTurn` (key
	 * undefined) dedups only on the derived PK (`${sessionKey}:${ts}:${role}`).
	 *
	 * Returns `true` when a row was actually inserted, `false` on an idempotency
	 * hit (the keyed/PK row already existed). The boolean is load-bearing — it is
	 * the sole dedup signal callers gate per-turn side effects on (daily-log
	 * enqueue, fan-out), replacing the old scan-based `.some(listTurns())` checks.
	 * `INSERT OR IGNORE ... RETURNING id` yields the inserted id on a real insert
	 * and zero rows when the conflict clause swallowed the row.
	 */
	appendTurnWithKey(turn: TediSessionTurn, idempotencyKey?: string): boolean {
		this.ensureSchema();
		const id = idempotencyKey
			? `${turn.sessionKey ?? ""}:${idempotencyKey}`
			: deriveEntryId(turn);
		const rows = this.sql<{ id: string }>`
			INSERT OR IGNORE INTO session_entries
				(id, session_key, parent_id, type, role, content, idempotency_key, ts,
				 model_provider, model_id)
			VALUES (
				${id},
				${turn.sessionKey ?? ""},
				${null},
				${"message"},
				${turn.role},
				${turn.content},
				${idempotencyKey ?? null},
				${turn.ts},
				${turn.modelIdentity?.provider ?? null},
				${turn.modelIdentity?.model ?? null}
			)
			RETURNING id
		`;
		return rows.length > 0;
	}

	/**
	 * Exact-keyed read: the message turn appended under a deterministic
	 * `idempotencyKey` (the ledger `{runId}:{seq}` scheme, see
	 * {@link deriveIdempotencyKey}) for one conversation, or `null` when it has
	 * not landed. The partial unique `(session_key, idempotency_key)` index
	 * guarantees at most one row. This is the settle-probe for the durable MCP
	 * `run_tedi_turn` path: the DO polls for this turn's `{runId}:2` assistant
	 * row — never a heuristic "latest assistant after ts" scan that a concurrent
	 * turn could satisfy.
	 */
	findTurnByIdempotencyKey(
		sessionKey: string,
		idempotencyKey: string,
	): TediSessionTurn | null {
		this.ensureSchema();
		const rows = this.sql<SessionEntryRow>`
			SELECT session_key, role, content, ts, model_provider, model_id
			FROM session_entries
			WHERE session_key = ${sessionKey} AND idempotency_key = ${idempotencyKey}
			LIMIT 1
		`;
		const row = rows[0];
		return row ? rowToTurn(row) : null;
	}

	/**
	 * Durable per-conversation transcript — reads the canonical D1 messages and
	 * latest persisted compaction state atomically, then applies the body-neutral
	 * overlay. The repo's DO-local marker is only a hot projection; this durable
	 * projection is what survives eviction and runtime-body swaps.
	 */
	readMessages(
		sessionKey: string,
		limit?: number,
	): Promise<TediSessionContextEntry[]> {
		return this.readDurable(sessionKey, limit).then((state) =>
			projectDurableCompaction(state.entries, state.compaction),
		);
	}

	// ── Branch traversal and compaction (all append-only) ───────────────────

	/**
	 * The branch for a conversation: the path-to-root from `leafId` (or, when
	 * omitted, the latest entry by ts in `sessionKey` — the implicit leaf the
	 * append-only log keeps). Returns full {@link SessionEntry} rows root-first
	 * — feed straight into {@link projectBranch} for the model view.
	 */
	getBranch(sessionKey: string, leafId?: string): SessionEntry[] {
		this.ensureSchema();
		const entries = this.readAllEntries(sessionKey);
		if (entries.length === 0) return [];
		const leaf = leafId ?? entries[entries.length - 1]!.id;
		return pathToRoot(entries, leaf);
	}

	/**
	 * Append a `compaction` marker (append-only — no message row is deleted or
	 * mutated; the overlay just skips pre-`firstKeptEntryId` rows at read time).
	 * `parent_id` is the current leaf (latest ts) so the marker sits at the branch tip. The
	 * summary text lives in `content`; `firstKeptEntryId` / `tokensBefore` go in the
	 * phase-2 columns. The marker's id embeds the cut boundary so re-compaction at
	 * the same cut is idempotent under the PK.
	 */
	appendCompaction(
		sessionKey: string,
		opts: { summary: string; firstKeptEntryId: string; tokensBefore: number },
	): { id: string; ts: number } {
		this.ensureSchema();
		const entries = this.readAllEntries(sessionKey);
		const leaf = entries.length > 0 ? entries[entries.length - 1]!.id : null;
		const ts =
			entries.length > 0 ? entries[entries.length - 1]!.ts : Date.now();
		const id = `${sessionKey}:compaction:${opts.firstKeptEntryId}`;
		this.sql`
			INSERT OR IGNORE INTO session_entries
				(id, session_key, parent_id, type, role, content, idempotency_key, ts,
					first_kept_entry_id, tokens_before)
			VALUES (
				${id},
				${sessionKey},
				${leaf},
				${"compaction"},
				${"assistant"},
				${opts.summary},
				${null},
				${ts},
				${opts.firstKeptEntryId},
				${opts.tokensBefore}
			)
		`;
		return { id, ts };
	}

	/**
	 * Non-destructive per-session compaction. Computes the cut via
	 * {@link findCutPoint} over the current branch, runs the injected `summarize`
	 * port on the HEAD span (everything before the cut), and appends a `compaction`
	 * marker. The `summarize` port is the LLM seam — do.ts backs it with
	 * `apps/tedi-runtime/src/pi-compaction.ts`'s summarizer; this file stays free of
	 * `@cloudflare/*`/Azure imports. Best-effort: a null return or a throw from the
	 * port (or no head to compact) is a silent no-op — compaction never throws into
	 * a turn.
	 *
	 * Returns a {@link CompactionResult} so the queued caller (`do.ts`
	 * `onCompactSession`) can emit one canonical `context.compacted` runtime event
	 * to `tedi_runtime_events` only when a cut actually happened — making isolate
	 * compaction observable in the ledger. `{ compacted:true, ... }` on a real cut;
	 * `{ compacted:false }` when the head fits under budget / the summarizer
	 * returns null/blank; `null` when there is no branch at all. Any internal throw
	 * degrades to `{ compacted:false }` (never propagates into the turn).
	 *
	 * `opts.keepRecentTokens` overrides the instance budget for this pass only — the
	 * force hook (`/__admin/force-compact` → `do.ts`) passes a tiny budget (e.g. 0)
	 * so a short proof session always cuts, instead of needing a 20k-token
	 * conversation to cross the default threshold. Omitted ⇒ the configured
	 * {@link DEFAULT_KEEP_RECENT_TOKENS} budget (normal per-turn behaviour).
	 */
	async compactSession(
		sessionKey: string,
		summarize: TediSessionSummarizer,
		opts?: TediSessionCompactOptions,
	): Promise<CompactionResult | null> {
		try {
			this.ensureSchema();
			const branch = this.getBranch(sessionKey);
			if (branch.length === 0) return null;
			const keepRecentTokens = opts?.keepRecentTokens ?? this.keepRecentTokens;
			const cut = findCutPoint(branch, keepRecentTokens);
			// head fits under the keep budget → no-op
			if (!cut.firstKeptId) return { compacted: false };

			// #7 incremental compaction: roll forward from the last compaction marker.
			// getBranch returns the raw branch (already-summarized history + prior
			// markers are still present), so only summarize the delta since the prior
			// cut and feed the prior summary to the summarizer to enrich rather than
			// re-summarize from scratch.
			let prevSummary: string | undefined;
			let prevCutId: string | undefined;
			for (const e of branch) {
				if (e.type === "compaction") {
					prevSummary = e.content;
					prevCutId = e.firstKeptEntryId ?? undefined;
				}
			}

			// HEAD span = message entries in [prevCut, cut) — the delta to summarize
			// (the whole pre-cut span when there is no prior marker).
			const head: TediSessionContextEntry[] = [];
			let tokensBefore = 0;
			let started = !prevCutId;
			for (const e of branch) {
				if (e.id === cut.firstKeptId) break;
				if (!started) {
					// skip the already-summarized span up to the prior cut boundary
					if (e.id === prevCutId) started = true; // include from the prior cut onward
					else continue;
				}
				if (e.type === "message") {
					head.push({ role: e.role, content: e.content, ts: e.ts });
				}
				tokensBefore += estimateTokens(e.content);
			}
			if (head.length === 0) return { compacted: false };

			const summary = await summarize(head, prevSummary);
			if (!summary || !summary.trim()) return { compacted: false }; // best-effort no-op

			const marker = this.appendCompaction(sessionKey, {
				summary,
				firstKeptEntryId: cut.firstKeptId,
				tokensBefore,
			});
			const cutIndex = branch.findIndex(
				(entry) => entry.id === cut.firstKeptId,
			);
			const checkpointEntries = branch
				.slice(0, cutIndex)
				.filter((entry) => entry.type === "message");
			const checkpoint = await buildReplayCheckpoint(
				checkpointEntries,
				checkpointEntries.at(-1)?.id ?? cut.firstKeptId,
			);

			return {
				compacted: true,
				summary,
				summaryChars: summary.length,
				firstKeptEntryId: cut.firstKeptId,
				tokensBefore,
				markerTs: marker.ts,
				checkpoint,
			};
		} catch {
			// Best-effort: never propagate a compaction failure into the turn.
			return { compacted: false };
		}
	}
}
