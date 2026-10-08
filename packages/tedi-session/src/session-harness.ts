/**
 * Tedi session harness — BODY-NEUTRAL per-conversation contract.
 *
 * The canonical per-conversation state of a TEDI belongs to the tedi IDENTITY,
 * not its runtime body. Every tedi is the Agent runtime (the Cloudflare
 * Agents Worker + Durable Object with native Pi facets, `apps/tedi-runtime`). Cognitive state
 * lives in D1 + Cloudflare Agent Memory + Neo4j, not in the runtime body.
 *
 * Therefore this contract MUST stay body-neutral: no `@cloudflare/*` /
 * Durable-Object types leak through. The implementation is DO-backed for the
 * Agent runtime. The canonical conversation transcript already lives
 * body-neutrally in the cognitive ledger (`tedi_runtime_events`, D1); a
 * DO-local store is only an Agent-runtime cache.
 *
 * Layering (see `docs/engineering/tedi/agent-runtime.md`):
 *   Brain (D1+Neo4j, shared cross-conversation memory)  — separate, untouched here
 *   Cognitive ledger (D1, durable transcript/proof)      — canonical, body-neutral
 *   TediSessionHarness (per-sessionKey context + append)
 *   Native Pi session store (DO-local context — not the canonical transcript)
 */

/** Provider/model that actually served one model-backed turn. */
export interface TediSessionModelIdentity {
	provider: string;
	model: string;
}

/** Body-neutral attachment reference. Storage owners validate and resolve content. */
export interface TediSessionAttachment {
	type: "audio" | "file" | "image";
	content: string;
	fileName: string;
	mimeType: string;
	size?: number;
	durationMs?: number;
}

/** One conversation turn. Body-neutral. */
export interface TediSessionTurn {
	role: "user" | "assistant";
	content: string;
	attachments?: TediSessionAttachment[];
	/** Conversation key — the per-conversation boundary. Absent ⇒ the default
	 * `agent:main:main` conversation. */
	sessionKey?: string;
	/** Epoch millis. */
	ts: number;
	/**
	 * Actual provider/model selected by the runtime for this turn. This is audit
	 * metadata only: model-context projections deliberately strip it. Present on
	 * blind judge replies so durable `run_tedi_turn` redelivery cannot erase the
	 * identity of the verifier that produced the verdict.
	 */
	modelIdentity?: TediSessionModelIdentity;
}

/** Minimal model-context message. Body-neutral; no SDK shapes. This is the
 * MODEL BOUNDARY shape — `buildContext` returns these, stripped of metadata. */
export interface TediSessionMessage {
	role: "user" | "assistant";
	content: string;
	attachments?: TediSessionAttachment[];
}

/**
 * Internal context entry — a model message PLUS its turn `ts`. The harness
 * reconciles the durable transcript against the hot cache by stable `ts`, NOT by
 * content: a turn's durable ledger `createdAt` and its cache `recentTurns.ts`
 * both derive from the SAME turn timestamp, so `ts` is an exact, stable join key.
 * Content-keyed reconciliation would mis-align on repeated/identical messages
 * ("ok", "done", same tool summary) and silently drop history. Projected down to
 * {@link TediSessionMessage} only at the model boundary (`buildContext` output).
 */
export interface TediSessionContextEntry {
	role: "user" | "assistant";
	content: string;
	attachments?: TediSessionAttachment[];
	ts: number;
}

/**
 * One canonical durable-ledger message. The stable ledger event id is required
 * so a compaction cut can survive a runtime-body swap: unlike the DO-local
 * cache timestamp, this id is also the persisted `firstKeptEntryId` boundary.
 */
export interface TediSessionDurableEntry extends TediSessionContextEntry {
	id: string;
}

export interface TediSessionReplayRef {
	id: string;
	revision?: string;
	fingerprint: string;
}

export interface TediSessionReplayCheckpoint {
	version: 1;
	coveredThroughEntryId: string;
	capabilityBindings: Array<TediSessionReplayRef & { namespace: string }>;
	artifactRevisions: TediSessionReplayRef[];
	pendingApprovals: Array<TediSessionReplayRef & { status: "pending" }>;
	workReferences: Array<
		TediSessionReplayRef & {
			kind: "work_item" | "home_run" | "runtime_run";
		}
	>;
	toolResultDependencies: Array<TediSessionReplayRef & { toolCallId: string }>;
	contextSources: Array<TediSessionReplayRef & { kind: string }>;
	truncated: boolean;
	checkpointDigest: string;
}

/**
 * Latest canonical compaction overlay for one durable conversation. The
 * original ledger messages remain append-only; this state only controls their
 * body-neutral read projection.
 */
export interface TediSessionDurableCompaction {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	checkpoint?: TediSessionReplayCheckpoint;
}

/** Atomic durable read: message ledger plus its latest compaction overlay. */
export interface TediSessionDurableState {
	entries: TediSessionDurableEntry[];
	compaction: TediSessionDurableCompaction | null;
}

export interface TediSessionCompactionResult {
	compacted: boolean;
	/** Persistable summary text. Present when `compacted` is true. */
	summary?: string;
	summaryChars?: number;
	firstKeptEntryId?: string;
	tokensBefore?: number;
	markerTs?: number;
	checkpoint?: TediSessionReplayCheckpoint;
}

/** Render immutable replay evidence without implying restored authority. */
export function renderReplayCheckpoint(
	checkpoint: TediSessionReplayCheckpoint,
): string {
	return [
		"[Replay checkpoint: references only; revalidate capabilities and approvals before acting]",
		JSON.stringify(checkpoint),
	].join("\n");
}

/**
 * Apply a durable D1 compaction overlay to canonical ledger messages.
 *
 * The summary replaces every message before `firstKeptEntryId`; the boundary
 * and all newer messages remain verbatim. When a bounded durable read starts
 * after the boundary, the id is legitimately absent, so the whole returned
 * page is retained after the summary. This is the cold/cache-empty projection
 * used after DO eviction or a runtime-body swap.
 */
export function projectDurableCompaction(
	entries: ReadonlyArray<TediSessionDurableEntry>,
	compaction: TediSessionDurableCompaction | null,
): TediSessionContextEntry[] {
	if (!compaction) {
		return entries.map(({ role, content, ts }) => ({ role, content, ts }));
	}

	const firstKeptIndex = entries.findIndex(
		(entry) => entry.id === compaction.firstKeptEntryId,
	);
	const kept = firstKeptIndex >= 0 ? entries.slice(firstKeptIndex) : entries;
	const firstKeptTs = kept[0]?.ts ?? 0;
	return [
		{
			role: "assistant",
			content: compaction.summary,
			ts: firstKeptTs - 1,
		},
		...(compaction.checkpoint
			? [
					{
						role: "assistant" as const,
						content: renderReplayCheckpoint(compaction.checkpoint),
						ts: firstKeptTs - 0.5,
					},
				]
			: []),
		...kept.map(({ role, content, ts }) => ({ role, content, ts })),
	];
}

export type TediSessionSummarizer = (
	entries: TediSessionContextEntry[],
	// #7 incremental compaction: the prior compaction summary (if any) so the
	// summarizer can roll it forward/enrich instead of re-summarizing from scratch.
	// Optional + backward-compatible: a 1-arg summarizer still satisfies this type.
	previousSummary?: string,
) => Promise<string | null>;

export interface TediSessionCompactOptions {
	keepRecentTokens?: number;
}

export interface BuildContextOptions {
	/** Drop the in-flight user turn (matched on `ts`+role) so callers can append
	 * a wrapped/guarded variant themselves. */
	excludeUserTs?: number;
	/** Skip empty-content turns. */
	requireContent?: boolean;
}

/**
 * The body-neutral session contract. Runtime adapters implement it over their
 * native storage. Storage owners handle compaction outside this facade.
 */
export interface TediSessionHarness {
	/** Persist one turn under `sessionKey`, optionally deduped on a deterministic
	 * `idempotencyKey`. Returns whether a row was inserted (`false` on an
	 * idempotency hit). Callers gate per-turn side effects on the boolean. */
	appendTurn(
		sessionKey: string,
		turn: TediSessionTurn,
		idempotencyKey?: string,
	): boolean | Promise<boolean>;
	buildContext(
		sessionKey: string,
		opts?: BuildContextOptions,
	): TediSessionMessage[] | Promise<TediSessionMessage[]>;
}

/**
 * The canonical default conversation key. Kept as one named constant rather
 * than scattered literals.
 */
export const DEFAULT_SESSION_KEY = "agent:main:main";

/**
 * PURE read-contract: select ONE conversation's model context from a flat turn
 * list, filtered by `sessionKey`. This is the single guard against
 * cross-conversation context bleed — every
 * bespoke turn loop builds prompt history through this, never a raw all-turns
 * read. Pure + side-effect-free so it is unit-testable offline.
 */
export function selectSessionContext(
	turns: ReadonlyArray<TediSessionTurn>,
	sessionKey: string,
	opts?: BuildContextOptions,
): TediSessionContextEntry[] {
	const key = sessionKey || DEFAULT_SESSION_KEY;
	return turns
		.filter((t) => {
			if ((t.sessionKey || DEFAULT_SESSION_KEY) !== key) return false;
			if (
				opts?.requireContent &&
				t.content.trim().length === 0 &&
				!t.attachments?.length
			)
				return false;
			if (
				opts?.excludeUserTs != null &&
				t.ts === opts.excludeUserTs &&
				t.role === "user"
			)
				return false;
			return true;
		})
		.map((t) => ({
			role: t.role,
			content: t.content,
			ts: t.ts,
			...(t.attachments?.length ? { attachments: t.attachments } : {}),
		}));
}

/**
 * PURE reconciliation, keyed on stable `ts` (NOT content). The hot CACHE slice is
 * the BASE — the DO's correct, contiguous recent view (committed turns plus the
 * in-flight turn, already with any `excludeUserTs`/`requireContent` filtering
 * applied). The DURABLE transcript only BACK-FILLS the older history the cache no
 * longer holds (evicted under the `MAX_RECENT_TURNS` cap, or never loaded on a
 * fresh/rebound body). Returns `[durable entries STRICTLY OLDER than the cache
 * window] ++ cache`.
 *
 * The boundary is the cache window's earliest `ts` (`cache[0].ts`, since both
 * sides are ts-ascending). Every durable entry with `ts < cacheStart` is the
 * missing prefix; every durable entry with `ts >= cacheStart` is already in the
 * cache (the cache is a contiguous recent suffix, so nothing in that range is
 * absent from it) and is dropped to avoid duplication. A turn's durable
 * `createdAt` and its cache `recentTurns.ts` derive from the SAME timestamp, so
 * this join is exact — repeated/identical content can never mis-align the
 * boundary (the content-keyed predecessor could). This is also why the mesh
 * `excludeUserTs` case is safe: the excluded in-flight turn is the LATEST ts, so
 * dropping it from the cache never moves `cacheStart`, and a durable cache-
 * fallback that re-includes it is filtered out by `ts >= cacheStart`. This is the
 * property that makes an isolate↔runtime body swap (or DO eviction) non-lossy:
 * prompt history reconstructs from D1, not only the cache.
 */
export function mergeDurableAndCache(
	durable: ReadonlyArray<TediSessionContextEntry>,
	cache: ReadonlyArray<TediSessionContextEntry>,
): TediSessionContextEntry[] {
	if (cache.length === 0) return [...durable];
	if (durable.length === 0) return [...cache];
	const cacheStart = cache[0]?.ts ?? Number.POSITIVE_INFINITY;
	const prefix = durable.filter((d) => d.ts < cacheStart);
	return [...prefix, ...cache];
}

/** Project internal ts-carrying entries down to the model-boundary message shape. */
export function toMessages(
	entries: ReadonlyArray<TediSessionContextEntry>,
): TediSessionMessage[] {
	return entries.map((e) => ({
		role: e.role,
		content: e.content,
		...(e.attachments?.length ? { attachments: e.attachments } : {}),
	}));
}

/**
 * Storage PORT the harness depends on — the only seam a runtime body must
 * implement. Body-neutral: no SDK / DO runtime types. The isolate wires a
 * DO-backed port (recentTurns cache for `listTurns`/`appendTurn`, D1 ledger for
 * `readMessages`).
 * Swapping the backing store (e.g. recentTurns array → explicit branchable
 * DO-SQLite, or adding compaction) is a change behind this port, not in callers.
 */
export interface SessionHarnessBackend {
	/** The full turn cache (all conversations) — the harness slices per session. */
	listTurns(): ReadonlyArray<TediSessionTurn>;
	/** Persist one turn (already tagged with its `sessionKey`), optionally deduped
	 * on a deterministic `idempotencyKey`. Returns whether a row was inserted
	 * (`false` on an idempotency hit) so the harness can surface a load-bearing
	 * dedup signal to callers. */
	appendTurn(
		turn: TediSessionTurn,
		idempotencyKey?: string,
	): boolean | Promise<boolean>;
	/** Durable per-conversation transcript (isolate: the D1 ledger), carrying each
	 * entry's `ts` so the harness can reconcile against the cache by timestamp. */
	readMessages(
		sessionKey: string,
		limit?: number,
	): Promise<TediSessionContextEntry[]>;
}

/**
 * Reference {@link TediSessionHarness} over a pluggable {@link SessionHarnessBackend}.
 * `buildContext` is LEDGER-FIRST: it reconstructs prompt history from the durable
 * transcript (`readMessages`) and merges the in-flight tail from the hot cache
 * ({@link mergeDurableAndCache}), so a cold/rebound body still gets full context.
 * `appendTurn` stamps the `sessionKey` and delegates.
 */
export class SessionHarness implements TediSessionHarness {
	constructor(private readonly backend: SessionHarnessBackend) {}

	appendTurn(
		sessionKey: string,
		turn: TediSessionTurn,
		idempotencyKey?: string,
	): boolean | Promise<boolean> {
		// Stamp the conversation boundary; thread the idempotency key and pass
		// through the backend's sync/async nature + boolean dedup signal so callers
		// gate per-turn side effects on whether a row was actually inserted.
		return this.backend.appendTurn({ ...turn, sessionKey }, idempotencyKey);
	}

	async buildContext(
		sessionKey: string,
		opts?: BuildContextOptions,
	): Promise<TediSessionMessage[]> {
		// Hot cache slice — the runtime-local view. Includes the in-flight
		// (not-yet-committed) user turn the caller appended just before this call.
		const cache = selectSessionContext(
			this.backend.listTurns(),
			sessionKey,
			opts,
		);
		// LEDGER-FIRST: read the durable, canonical transcript. A fresh/rebound DO
		// (cold cache — body swap, eviction, cold start) has no `recentTurns`, so
		// prior history MUST be reconstructed from here, not only from the cache.
		let durable: TediSessionContextEntry[];
		try {
			durable = await this.backend.readMessages(sessionKey);
		} catch {
			// Durable read failed → degrade to the cache (functional, possibly thin)
			// rather than dropping context entirely. Never throw from a prompt build.
			return toMessages(cache);
		}
		if (durable.length === 0) return toMessages(cache); // brand-new conversation
		const durableFiltered = opts?.requireContent
			? durable.filter(
					(m) => m.content.trim().length > 0 || m.attachments?.length,
				)
			: durable;
		return toMessages(mergeDurableAndCache(durableFiltered, cache));
	}
}
