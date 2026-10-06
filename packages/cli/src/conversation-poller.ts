/**
 * ConversationPoller — polls readHomeMessages on a slow interval while the ink
 * REPL is active and surfaces NEW assistant messages that were NOT dispatched by
 * the operator (e.g. INBOX_WAKE wake-delivered results from delegated tedis).
 *
 * Dedup strategy
 * ─────────────
 * Each HomeMessage has a stable `id` field (UUID). We maintain a `seen` Set of
 * ids. A message is "new" when its id is absent from the set. The dispatch path
 * (backgroundSettleInk → bridge.commitLines) seeds `seen` with the settled
 * run's homeRunId-derived message ids by calling `markSeen`. The poller also
 * marks every message it surfaces so a subsequent poll never re-shows it.
 *
 * The poller pauses briefly while a dispatch is in-flight (opt-in via
 * `setInflight`) to reduce unnecessary MCP calls — but only for a bounded grace
 * period (`inflightGraceMs`). Past the grace window it polls even while
 * in-flight: a run that settled server-side while the CLI's settle path was
 * blind (stalled read, dropped WS) must still surface its assistant answer, or
 * the turn spinner would run forever. The SEEN/run-id sets are the
 * authoritative dedup gate either way.
 *
 * Fail-soft: any poll error leaves the transcript untouched. The poller never
 * throws. It stops when `stop()` is called (on REPL exit).
 */

import { HomeMessageSchema } from "@tedix/api-contract/schemas/kernel-runtime";
import { normalizeCodeResult } from "./code-result";
import { isRecord } from "@tedix/api-contract/utils/is-record";

// ── Message shape (subset of HomeMessageSchema) ──────────────────────────────

export interface PolledMessage {
	id: string;
	role: string;
	content: string;
	/** The homeRun/run id that produced this message (from message.runId). */
	runId?: string;
	/** ISO timestamp, used for secondary sort if needed. */
	createdAt?: string;
}

/**
 * Parse a `readHomeMessages` tool response into a flat array of PolledMessages.
 * Tolerant of the live envelope shape: `{ messages: [...] }` or `{ data: [...] }`
 * or a raw array at the root. Each element must have an `id` and a `role`.
 */
export function parseHomeMessagesPayload(payload: unknown): PolledMessage[] {
	const arr = extractMessageArray(payload);
	// Fast path: when the array validates against the contract, project the typed
	// HomeMessages (same shape the API serves + Tedix OS consumes). Otherwise fall back
	// to the tolerant per-field dig below — fail-open, never throws.
	const parsed = HomeMessageSchema.array().safeParse(arr);
	if (parsed.success) {
		return parsed.data.map((m) => ({
			id: m.id,
			role: m.role,
			content: m.content,
			...(m.runId ? { runId: m.runId } : {}),
			...(m.createdAt ? { createdAt: m.createdAt } : {}),
		}));
	}
	if (process.env.TEDIX_DEBUG && arr.length > 0) {
		console.error(
			"[parseHomeMessagesPayload] payload failed HomeMessageSchema; using fallback:",
			parsed.error.issues.slice(0, 3),
		);
	}
	const result: PolledMessage[] = [];
	for (const entry of arr) {
		if (!isRecord(entry)) continue;
		const id = typeof entry.id === "string" ? entry.id.trim() : "";
		const role = typeof entry.role === "string" ? entry.role.trim() : "";
		if (!id || !role) continue;
		const content = typeof entry.content === "string" ? entry.content : "";
		const createdAt =
			typeof entry.createdAt === "string" ? entry.createdAt : undefined;
		const runId = typeof entry.runId === "string" ? entry.runId : undefined;
		result.push({ id, role, content, runId, createdAt });
	}
	return result;
}

function extractMessageArray(payload: unknown): unknown[] {
	// Every CLI read runs as Code Mode, so what arrives here is the gateway
	// envelope `{ executionId, result, logs }` and the messages live under
	// `result`. Digging for `messages` at the ROOT of that envelope found nothing
	// on every real payload, which is why a delegated tedi's async-completion
	// answer never reached the REPL transcript.
	const value = normalizeCodeResult(payload).value;
	if (Array.isArray(value)) return value;
	if (!isRecord(value)) return [];
	for (const key of ["messages", "data", "items", "results"]) {
		if (Array.isArray(value[key])) return value[key] as unknown[];
	}
	return [];
}

// ── Callback types ────────────────────────────────────────────────────────────

export interface ConversationPollerOptions {
	/** Called once per new assistant message (never called with already-seen ids). */
	onNewAssistantMessage: (msg: PolledMessage) => void;
	/** Called when a poll errors (fail-soft; do not crash). */
	onError?: (error: unknown) => void;
	/** How often to poll in ms. Default: 4 000. */
	intervalMs?: number;
	/**
	 * How long an in-flight dispatch suppresses polling, in ms. Default: 120 000
	 * (the foreground settlement budget). This reader is a recovery path, not a
	 * competing live-feed loop.
	 * After this grace period the poller polls even while a dispatch is
	 * in-flight so a server-settled-but-CLI-blind turn still surfaces.
	 */
	inflightGraceMs?: number;
	/** Read messages for this conversation. */
	conversationId: string;
	/** Fetch function — takes conversationId, returns the raw MCP payload. */
	readMessages: (conversationId: string) => Promise<unknown>;
	/** REPL-start epoch ms; messages older than this never surface. Default: now. */
	sinceTs?: number;
}

// ── Poll state (injectable for tests) ────────────────────────────────────────

/**
 * Mutable poll state held by the poller.  Separated from the options so tests
 * can share a reference and observe mutations without accessing private fields.
 *
 * @internal  Not part of the public API — exported only for the test file.
 */
export interface PollerState {
	/** Message ids already shown/seeded — the authoritative dedup gate. */
	seen: Set<string>;
	/**
	 * Home run ids whose output messages were already committed by the dispatch
	 * path.  Any assistant message whose runId is in this set is skipped so a
	 * dispatch-settled answer never appears twice in the transcript.
	 */
	seenRunIds: Set<string>;
	/** >0 when a dispatch is in-flight; poller skips ticks within the grace window. */
	inflightCount: number;
	/** Epoch ms when the current in-flight window started (undefined = idle). */
	inflightSince?: number;
	/**
	 * Epoch ms of REPL session start. Messages created before this never surface
	 * (the authoritative guard against bursting pre-existing history). Undefined
	 * disables the time gate (used by pure tests that drive createdAt-less msgs).
	 */
	sinceTs?: number;
}

/**
 * Process one page of messages against the current state.
 *
 * Exported as a pure function so tests can drive it directly without timers.
 * Returns the list of new assistant messages that should be surfaced.
 */
export function processPollPage(
	payload: unknown,
	state: PollerState,
): PolledMessage[] {
	const messages = parseHomeMessagesPayload(payload);
	// Messages arrive newest-first from the API; reverse for chronological
	// delivery so multiple proactive messages appear in order.
	const chronological = [...messages].reverse();
	const surfaced: PolledMessage[] = [];
	for (const msg of chronological) {
		if (state.seen.has(msg.id)) continue;
		// Only surface assistant messages — user messages are the operator's
		// own input and are already in the transcript.
		if (msg.role !== "assistant") {
			state.seen.add(msg.id);
			continue;
		}
		// A content-less assistant row is never worth a transcript line. Home
		// serves one for a delegation whose lifecycle NARRATION was collapsed
		// into the structured delegation metadata (apps/api
		// `kernel/home-narration.ts`): the row survives so Tedix OS can render its
		// receipt from that metadata, but the CLI has no receipt row and would
		// print a blank turn.
		if (msg.content.trim().length === 0) {
			state.seen.add(msg.id);
			continue;
		}
		// Never surface messages that predate the REPL session — this is the
		// authoritative guard against bursting old conversation history on
		// startup (the SEEN seed is only a backstop, capped at 50). A genuine
		// proactive delivery (INBOX_WAKE) is created DURING the session, so its
		// createdAt is always > sinceTs.
		if (msg.createdAt && state.sinceTs !== undefined) {
			const ts = Date.parse(msg.createdAt);
			if (Number.isFinite(ts) && ts < state.sinceTs) {
				state.seen.add(msg.id);
				continue;
			}
		}
		// Skip messages whose run was already committed by the dispatch path.
		if (msg.runId && state.seenRunIds.has(msg.runId)) {
			state.seen.add(msg.id);
			continue;
		}
		state.seen.add(msg.id);
		surfaced.push(msg);
	}
	return surfaced;
}

// ── ConversationPoller ────────────────────────────────────────────────────────

export class ConversationPoller {
	readonly #opts: Required<
		Omit<ConversationPollerOptions, "onError" | "sinceTs">
	> &
		Pick<ConversationPollerOptions, "onError">;

	readonly #state: PollerState = {
		seen: new Set<string>(),
		seenRunIds: new Set<string>(),
		inflightCount: 0,
	};

	#timer: ReturnType<typeof setTimeout> | undefined;
	#stopped = false;
	#polling = false;

	constructor(opts: ConversationPollerOptions) {
		this.#opts = {
			onNewAssistantMessage: opts.onNewAssistantMessage,
			onError: opts.onError,
			intervalMs: opts.intervalMs ?? 4_000,
			inflightGraceMs: opts.inflightGraceMs ?? 120_000,
			conversationId: opts.conversationId,
			readMessages: opts.readMessages,
		};
		// Never surface conversation history that predates this REPL session.
		this.#state.sinceTs = opts.sinceTs ?? Date.now();
	}

	/**
	 * Retarget the poller to another conversation (session switch in the REPL).
	 * Resets the since-gate to "now" so the switched-to conversation's history
	 * doesn't burst into the transcript; the SEEN sets are keyed by globally
	 * unique message ids, so they carry over safely.
	 */
	setConversationId(conversationId: string): void {
		this.#opts.conversationId = conversationId;
		this.#state.sinceTs = Date.now();
	}

	/** The conversation currently being polled. */
	get conversationId(): string {
		return this.#opts.conversationId;
	}

	/**
	 * Seed a known message id into SEEN without triggering a callback.
	 * Call this for every message committed by the dispatch path so the poller
	 * never double-shows it.
	 */
	markSeen(id: string): void {
		this.#state.seen.add(id);
	}

	/**
	 * Seed a home run id whose output message was already committed by the
	 * dispatch path. The poller skips any assistant message whose `runId` matches,
	 * preventing the dispatch-settled answer from appearing twice in the transcript.
	 *
	 * Call from backgroundSettleInk immediately before bridge.commitLines.
	 */
	markRunSeen(homeRunId: string): void {
		this.#state.seenRunIds.add(homeRunId);
	}

	/**
	 * Mark a run as in-flight. The poller skips polls only within the
	 * `inflightGraceMs` window; past it, polling resumes even while in-flight so
	 * a server-settled turn the settle path lost track of still surfaces.
	 * Call `clearInflight` when the dispatch settles.
	 */
	setInflight(): void {
		if (this.#state.inflightCount === 0) {
			this.#state.inflightSince = Date.now();
		}
		this.#state.inflightCount++;
	}

	/** Mark one in-flight dispatch as settled. */
	clearInflight(): void {
		if (this.#state.inflightCount > 0) this.#state.inflightCount--;
		if (this.#state.inflightCount === 0) {
			this.#state.inflightSince = undefined;
		}
	}

	/** True when at least one dispatch is in-flight. */
	get isInflight(): boolean {
		return this.#state.inflightCount > 0;
	}

	/** Start polling. Safe to call once. */
	start(): void {
		if (this.#stopped) return;
		this.#scheduleNext();
	}

	/** Stop polling permanently (called on REPL exit). */
	stop(): void {
		this.#stopped = true;
		if (this.#timer !== undefined) {
			clearTimeout(this.#timer);
			this.#timer = undefined;
		}
	}

	// ── Internal ─────────────────────────────────────────────────────────────

	#scheduleNext(): void {
		if (this.#stopped) return;
		this.#timer = setTimeout(() => {
			void this.#doPoll();
		}, this.#opts.intervalMs);
		this.#timer.unref?.();
	}

	async #doPoll(): Promise<void> {
		if (this.#stopped) return;
		// Skip while a dispatch is in-flight (reduces load) — but only within the
		// grace window. Past it, keep polling even while in-flight: a turn that
		// settled server-side while the CLI's settle path stayed blind must still
		// surface its answer (dedup via SEEN/run-id sets covers the race with the
		// settle path).
		if (this.#state.inflightCount > 0) {
			const since = this.#state.inflightSince ?? 0;
			if (Date.now() - since < this.#opts.inflightGraceMs) {
				this.#scheduleNext();
				return;
			}
		}
		if (this.#polling) {
			// Prevent concurrent polls from a slow network call.
			this.#scheduleNext();
			return;
		}
		this.#polling = true;
		try {
			const payload = await this.#opts.readMessages(this.#opts.conversationId);
			if (this.#stopped) return;
			const surfaced = processPollPage(payload, this.#state);
			for (const msg of surfaced) {
				try {
					this.#opts.onNewAssistantMessage(msg);
				} catch {
					// Callback error must not stop the poller.
				}
			}
		} catch (error) {
			// Fail-soft: poll errors never crash or affect the transcript.
			try {
				this.#opts.onError?.(error);
			} catch {
				// ignore callback errors
			}
		} finally {
			this.#polling = false;
			this.#scheduleNext();
		}
	}
}
