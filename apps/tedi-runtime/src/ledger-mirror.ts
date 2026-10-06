/**
 * Ledger mirror — dual-write of isolate-tier chat turns into the canonical
 * cognitive-runtime event ledger (D1 `tedi_runtime_events`).
 *
 * The DO is the SINGLE EMITTER for these events (no edge mirror). This avoids
 * the double-write inflation risk documented in `docs/cognition/runtime.md`
 * "Audit 2" for the runtime path.
 *
 * Per turn we emit a deterministic four-event sequence keyed on a stable
 * `runId = "{tediId}:{surface}:{turnKey}"` (turnKey = the inbound client id):
 *
 *   seq 0  message.received   role=user      payload.content = user text
 *   seq 1  run.started        (run boundary)
 *   seq 2  message.completed  role=assistant payload.content = assistant text
 *   seq 3  run.completed
 *
 * Per-call failures are caught individually so one bad write does not lose
 * the rest of the sequence. Every event carries the same deterministic
 * (tediId, runId, sequence) tuple so the API's conflict-do-nothing on
 * `runtimeEventId(...)` makes the mirror idempotent on retries.
 */

import { callRpc } from "@tedix/api-client/internal";
import type { BodyExecutionUsage } from "@tedix/api-contract/schemas/body-certification";
import {
	classifyRunTerminalReason,
	type ReadMessagesOutput,
	type TediRuntimeEvent,
	type TediRuntimeEventKind,
} from "@tedix/api-contract/schemas/cognitive-runtime";
import { buildTediTurnRuntimeEvent } from "@tedix/api-contract/utils/runtime-events";
import { DescopeAccessKeyExchange } from "@tedix/auth/access-key-exchange";
import {
	buildRuntimeRunId,
	buildRuntimeWorkflowInstanceId,
	isEphemeralSessionKey,
	parseRuntimeRunSurface,
	sanitizeRuntimeTurnKey,
} from "@tedix/api-contract/utils/runtime-identity";
import type { HttpPlatformClient } from "./brain/platform-client";
import type { TediSessionDurableState } from "@tedix/tedi-session/session-harness";
import {
	ledgerReadToDurableState,
	type LedgerConversationRead,
} from "./compaction-ledger";
import type { DurableCodePause } from "./durable-codemode-lifecycle";
import { exceptionTopology } from "./exception-topology";
import { loadTediSecrets } from "./platform-client-factory";

const RUNTIME_BACKEND = "cloudflare-agents" as const;

interface TurnBlob {
	content: string;
	attachments?: LedgerAttachment[];
	ts: number;
}

interface LedgerAttachment {
	content: string;
	fileName: string;
	mimeType: string;
	type: "audio" | "file" | "image";
}

export interface MirrorTurnOpts {
	platform: HttpPlatformClient;
	tediId: string;
	organizationId?: string;
	conversationId: string;
	/**
	 * Pre-built STABLE per-turn runId (`{tediId}:{surface}:{turnKey}`), derived
	 * by the caller from the inbound client-generated message id — NOT from a
	 * wall-clock. Threaded through so the `{runId}:{seq}` event-id dedup keys on
	 * the same logical turn across workflow resume / mesh redelivery / DO restart.
	 * `userTurn.ts` / `assistantTurn.ts` are used ONLY for the `createdAt` ISO
	 * timestamps (those are legitimately wall-clock).
	 */
	runId: string;
	userTurn: TurnBlob;
	assistantTurn: TurnBlob;
	/** Cross-layer request trace propagated from the MCP gateway, when present. */
	traceId?: string;
	/**
	 * If true, prepend a `conversation.created` event (sequence -1 → we use
	 * the run id without sequence; first-event-only). The DO tracks whether
	 * a conversationId has already seen a created event in its own state.
	 */
	emitConversationCreated?: boolean;
	/**
	 * Total tokens consumed by this isolate turn (input + output summed across
	 * all inference steps), lifted from the trace-bundle's `scores.json`
	 * `totalTokens` accumulator. Absent (not zero) when no step telemetry was
	 * collected — the same null-absent invariant the kernel side applies so
	 * observers can distinguish "no usage data" from "zero tokens used".
	 */
	tokensUsed?: number | null;
	/**
	 * Canonical per-turn usage breakdown (provider/model + input/output/cache
	 * token counts) for the `run.completed` event's `payload.usage`, promoted into
	 * the typed `TediRuntimeEvent.usage` field on read. The SAME object stamped on
	 * the run's `BodyExecutionResult.usage`; `tokensUsed` stays as the scalar
	 * analytics mirror. Absent when no step telemetry was collected (null-absent).
	 */
	usage?: BodyExecutionUsage | null;
	/** Structured early-stop reason for continuation-required partial turns. */
	stopReason?: string;
	/** When present, the turn parks instead of emitting run.completed. */
	durableCodePause?: DurableCodePause;
	/**
	 * Durable sink for a TERMINAL event that exhausted in-process retries.
	 * Without it the settlement boundary dies with a console line; with it the
	 * DO persists the event and redrives it on a schedule (idempotent server
	 * dedup makes replays safe).
	 */
	onTerminalDrop?: TerminalDropHandler;
}

function isoFromTs(ts: number): string {
	return new Date(ts).toISOString();
}

/**
 * Build the deterministic per-turn runId: `${tediId}:${surface}:${turnKey}`.
 * `surface` is a body-neutral channel tag (`chat` | `mcp`), never a body name —
 * an isolate facet and a runtime body both emit `chat` for interactive turns.
 * `turnKey` is a STABLE, colon-free token derived from the inbound message's
 * client-generated id (sanitized via {@link sanitizeTurnKey}), never a
 * wall-clock or server-generated random.
 */
export function buildRunId(
	tediId: string,
	turnKey: string,
	surface: string = "chat",
): string {
	return buildRuntimeRunId({ tediId, turnKey, surface });
}

/**
 * Normalize a raw client-generated id into a colon-free, whitespace-collapsed
 * `turnKey` safe for the `${tediId}:${surface}:${turnKey}` runId scheme.
 *
 * - Strips surrounding `<>` (email Message-IDs are angle-bracketed).
 * - Replaces every `:` with `_` — a colon in the key would shift the
 *   second-to-last segment {@link parseRunSurface} reads, corrupting the
 *   surface tag and the `{runId}:{seq}` event-id dedup.
 * - Collapses internal whitespace runs to a single `_` and trims.
 *
 * Throws on an empty result: callers MUST pass a real inbound id. A fabricated
 * (clock/random) key is the bug this refactor removes, so we fail loudly rather
 * than invent one.
 */
export function sanitizeTurnKey(raw: string): string {
	return sanitizeRuntimeTurnKey(raw);
}

export function buildWorkflowInstanceId(raw: string): string {
	return buildRuntimeWorkflowInstanceId(raw);
}

/**
 * Extract the surface segment from a runId, preserving whatever tag it already
 * carries (including the legacy body-name tag `isolate`) so reconstruction is
 * byte-stable: `buildRunId(t, parseRunSurface(r) === surface ? key : key, ...)`
 * round-trips — concretely `buildRunId(t, key, parseRunSurface(r)) === r` for
 * any `r = ${t}:${surface}:${key}` where `t` is a colonless UUID and `key` is a
 * colon-free turnKey (the only kind {@link buildRunId} ever produces). This is
 * what keeps the `{runId}:{seq}` event-id dedup from breaking on the deploy
 * boundary.
 */
export function parseRunSurface(runId: string): string {
	return parseRuntimeRunSurface(runId);
}

/**
 * Runtime event kinds that close a run. A transient failure on one of these
 * strands the run as a ledger orphan (the success/turn_summary landed but the
 * ledger never sees the run finish), so {@link safeRecord} retries these before
 * giving up and escalates a still-failed terminal write to `console.error`.
 * Non-terminal events stay best-effort (single attempt) — over-retrying every
 * write would just amplify load on a degraded API for low-value seq0..seq2 rows.
 */
const TERMINAL_KINDS: ReadonlySet<TediRuntimeEventKind> = new Set([
	"run.completed",
	"run.failed",
	"run.canceled",
]);

/** Terminal-write retry budget + backoff (short — this is on a queued step). */
const TERMINAL_MAX_ATTEMPTS = 3;
const TERMINAL_BACKOFF_MS = 150;

function isTerminalEvent(event: TediRuntimeEvent): boolean {
	return TERMINAL_KINDS.has(event.kind);
}

/**
 * Callback invoked when a TERMINAL event exhausted its in-process retries.
 * The DO passes its outbox enqueue here so the event survives the isolate
 * (DO storage + scheduled redrive) instead of dying with a console line.
 */
export type TerminalDropHandler = (
	event: TediRuntimeEvent,
) => Promise<void> | void;

async function safeRecord(
	platform: HttpPlatformClient,
	event: TediRuntimeEvent,
	label: TediRuntimeEventKind,
	onTerminalDrop?: TerminalDropHandler,
): Promise<void> {
	const terminal = isTerminalEvent(event);
	const maxAttempts = terminal ? TERMINAL_MAX_ATTEMPTS : 1;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			await platform.recordRuntimeEvent(event);
			console.log({
				component: "tedi-runtime-ledger-mirror",
				event: "tedi.ledger.recorded",
				kind: label,
				sequence: event.sequence ?? null,
			});
			return;
		} catch (err) {
			if (attempt < maxAttempts) {
				console.warn({
					component: "tedi-runtime-ledger-mirror",
					event: "tedi.ledger.record_retry",
					kind: label,
					sequence: event.sequence ?? null,
					attempt,
					limit: maxAttempts,
					exception: exceptionTopology(err),
				});
				// Idempotent on the server, so a retry after partial success is safe.
				await new Promise((resolve) =>
					setTimeout(resolve, TERMINAL_BACKOFF_MS * attempt),
				);
				continue;
			}
			if (terminal) {
				// Preserve the alertable marker and durable outbox handoff.
				console.error({
					_tr: "ledger_terminal_dropped",
					component: "tedi-runtime-ledger-mirror",
					event: "tedi.ledger.terminal_dropped",
					kind: label,
					sequence: event.sequence ?? null,
					attempts: maxAttempts,
					outbox: Boolean(onTerminalDrop),
					exception: exceptionTopology(err),
				});
				if (onTerminalDrop) {
					try {
						await onTerminalDrop(event);
					} catch (outboxErr) {
						console.error({
							component: "tedi-runtime-ledger-mirror",
							event: "tedi.ledger.outbox_enqueue_failed",
							kind: label,
							sequence: event.sequence ?? null,
							exception: exceptionTopology(outboxErr),
						});
					}
				}
			} else {
				console.warn({
					component: "tedi-runtime-ledger-mirror",
					event: "tedi.ledger.record_failed",
					kind: label,
					sequence: event.sequence ?? null,
					exception: exceptionTopology(err),
				});
			}
		}
	}
}

/**
 * Session-key convention for EPHEMERAL (test / validation) traffic.
 *
 * The DO builds `conversationId = "{slug}:{sessionKey}"` and durably mirrors
 * every turn to the cognitive ledger. Validation harnesses (codex/claude/val/
 * smoke/probe) that mint real chat turns would therefore leave permanent ledger
 * conversations. Any harness that prefixes its session key with `__throwaway:`
 * (or `__test:`) opts that traffic out of durable ledger mirroring + brain
 * bridging — the turn still runs and replies normally; it just isn't recorded.
 *
 * `sessionKey` here is the part AFTER the slug in the conversation id.
 */
export function isEphemeralSession(sessionKey: string | undefined): boolean {
	return isEphemeralSessionKey(sessionKey);
}

/**
 * Build a single canonical event blob.
 *
 * The API contract (`RecordRuntimeEventInputSchema`) accepts optional `id`
 * and `createdAt`, but the `HttpPlatformClient.recordRuntimeEvent(...)` type
 * is `TediRuntimeEvent` (strict). We populate both so the call type-checks
 * and the server still gets deterministic, replay-safe IDs.
 */
function buildEvent(opts: {
	tediId: string;
	conversationId: string;
	runId: string;
	kind: TediRuntimeEventKind;
	sequence: number;
	createdAt: string;
	idSuffix: number | "conv-created";
	payload?: Record<string, unknown>;
	traceId?: string;
}): TediRuntimeEvent {
	return buildTediTurnRuntimeEvent({
		tediId: opts.tediId,
		kind: opts.kind,
		conversationId: opts.conversationId,
		runId: opts.runId,
		sequence: opts.sequence,
		idSuffix: opts.idSuffix,
		payload: opts.payload,
		runtimeBackend: RUNTIME_BACKEND,
		traceId: opts.traceId,
		createdAt: opts.createdAt,
	});
}

function messagePayload(turn: TurnBlob, role: "user" | "assistant") {
	return {
		role,
		content: turn.content,
		...(turn.attachments?.length ? { attachments: turn.attachments } : {}),
	};
}

export async function mirrorTurnToLedger(opts: MirrorTurnOpts): Promise<void> {
	const {
		platform,
		tediId,
		conversationId,
		runId,
		userTurn,
		assistantTurn,
		traceId,
		emitConversationCreated,
		tokensUsed,
		usage,
		durableCodePause,
	} = opts;

	const userIso = isoFromTs(userTurn.ts);
	const assistantIso = isoFromTs(assistantTurn.ts);

	if (emitConversationCreated) {
		await safeRecord(
			platform,
			buildTediTurnRuntimeEvent({
				tediId,
				kind: "conversation.created",
				conversationId,
				eventIdRunId: runId,
				idSuffix: "conv-created",
				runtimeBackend: RUNTIME_BACKEND,
				traceId,
				createdAt: userIso,
			}),
			"conversation.created",
		);
	}

	// seq 0 — message.received (user turn)
	await safeRecord(
		platform,
		buildEvent({
			tediId,
			conversationId,
			runId,
			kind: "message.received",
			sequence: 0,
			createdAt: userIso,
			idSuffix: 0,
			payload: messagePayload(userTurn, "user"),
			traceId,
		}),
		"message.received",
	);

	// seq 1 — run.started
	await safeRecord(
		platform,
		buildEvent({
			tediId,
			conversationId,
			runId,
			kind: "run.started",
			sequence: 1,
			createdAt: userIso,
			idSuffix: 1,
			traceId,
		}),
		"run.started",
	);

	// seq 2 — message.completed (assistant turn; full text, no delta promotion)
	await safeRecord(
		platform,
		buildEvent({
			tediId,
			conversationId,
			runId,
			kind: "message.completed",
			sequence: 2,
			createdAt: assistantIso,
			idSuffix: 2,
			payload: messagePayload(assistantTurn, "assistant"),
			traceId,
		}),
		"message.completed",
	);

	if (durableCodePause) {
		await safeRecord(
			platform,
			buildEvent({
				tediId,
				conversationId,
				runId,
				kind: "approval.requested",
				sequence: 3,
				createdAt: assistantIso,
				idSuffix: 3,
				traceId,
				payload: {
					surface: "durable_codemode",
					executionId: durableCodePause.executionId,
					pending: durableCodePause.pending,
				},
			}),
			"approval.requested",
		);
		return;
	}

	// seq 3 — run.completed (carry tokensUsed when present; absent = null-absent,
	// never zero). Also carry the canonical `usage` breakdown under
	// `payload.usage` so the ledger's typed `TediRuntimeEvent.usage` is populated
	// on read — the SAME object stamped on this run's BodyExecutionResult.
	const runCompletedPayload: Record<string, unknown> = {
		...(tokensUsed != null ? { tokensUsed } : {}),
		...(usage ? { usage } : {}),
		...(["budget_exhausted", "step_ceiling", "provider_error"].includes(
			opts.stopReason ?? "",
		)
			? { stopReason: opts.stopReason }
			: {}),
	};
	await safeRecord(
		platform,
		buildEvent({
			tediId,
			conversationId,
			runId,
			kind: "run.completed",
			sequence: 3,
			createdAt: assistantIso,
			idSuffix: 3,
			traceId,
			...(Object.keys(runCompletedPayload).length > 0
				? { payload: runCompletedPayload }
				: {}),
		}),
		"run.completed",
		opts.onTerminalDrop,
	);
}

export interface MirrorFailedTurnOpts {
	platform: HttpPlatformClient;
	tediId: string;
	organizationId?: string;
	conversationId: string;
	/**
	 * Pre-built STABLE per-turn runId (`{tediId}:{surface}:{turnKey}`), derived by
	 * the caller from the inbound client id — the SAME runId the success chain
	 * ({@link MirrorTurnOpts.runId}) would carry, so a failed run correlates with
	 * any partial-success events and stays idempotent on retries.
	 */
	runId: string;
	userTurn: TurnBlob;
	/**
	 * Optional user-facing assistant fallback. Failed MCP turns still return a
	 * helpful assistant message to the caller; when provided, mirror that text
	 * as a completed assistant message before the run.failed boundary so
	 * transcript reads survive reloads.
	 */
	assistantTurn?: TurnBlob;
	/** Cross-layer request trace propagated from the MCP gateway, when present. */
	traceId?: string;
	/** Error text describing why the turn failed. */
	error: string;
	/**
	 * Optional framework-owned chat-recovery context, attached to the terminal
	 * `run.failed` payload as `payload.recovery` when the failure is a recovery
	 * exhaustion. Lets Mission
	 * Control's rationale timeline distinguish a normal turn abort from a
	 * recovery give-up, and trace it back to the recovery incident
	 * (`rootRequestId`) without re-deriving anything. The ledger is NOT a store
	 * for the truncated partial — carry only a short prefix + its full length.
	 */
	recovery?: {
		/** Stable recovery incident identity (`recoveryRootRequestId`). */
		rootRequestId: string;
		/** Per-incident id. */
		incidentId?: string;
		/** Why recovery stopped. */
		reason: string;
		/** Attempts spent before the budget drained, when known. */
		attempts?: number;
		/** Max attempts the framework allowed before terminalizing recovery. */
		maxAttempts?: number;
		/** Whether recovery retried a user turn or continued a partial. */
		recoveryKind?: "retry" | "continue";
		/** Short prefix of whatever partial the turn produced (<=500 chars). */
		partialTextPrefix?: string;
		/** Full length of the partial in chars (the prefix above may be clipped). */
		partialTextLength: number;
		/** Always true on this path — the turn was interrupted, not a hard error. */
		interrupted?: true;
		/**
		 * R2 `bundleUri` of the recovery-incident trace bundle written for this
		 * run, when one was produced. Closes the ledger↔bundle linkage: the
		 * `run.failed` event points at the bundle folder, and the bundle's
		 * `recovery.json` points back at this run/version. Absent when no bundle
		 * could be written (R2 hiccup / no harness version).
		 */
		bundleUri?: string;
	};
	/**
	 * If true, prepend a `conversation.created` event so the conversation is
	 * registered even when its very first turn fails. The DO tracks dedup.
	 */
	emitConversationCreated?: boolean;
	/** Durable sink for a dropped terminal event; see {@link MirrorTurnOpts}. */
	onTerminalDrop?: TerminalDropHandler;
}

/**
 * Mirror a FAILED turn into the ledger. Unlike {@link mirrorTurnToLedger} (the
 * 4-event success chain) this emits the attempt + failure boundary so a turn
 * that aborted (LLM error, empty assistant message, etc.) is visible in
 * `tedi_runtime_events` instead of being indistinguishable from "never
 * happened":
 *
 *   conversation.created (optional, first turn only)
 *   seq 0  message.received   role=user      payload.content = user text
 *   seq 1  run.started        (run boundary)
 *   seq 2  message.completed  role=assistant payload.content = fallback text (optional)
 *   seq 2/3 run.failed        payload.error  = raw failure; reason when classified
 *
 * Shares the same deterministic `runId = "{tediId}:{surface}:{turnKey}"` as the
 * success chain so a failed run correlates with any partial success events
 * (e.g. tool.* emitted before the abort) and stays idempotent on retries.
 * Per-call failures are caught individually (`safeRecord`).
 */
export async function mirrorFailedTurnToLedger(
	opts: MirrorFailedTurnOpts,
): Promise<void> {
	const {
		platform,
		tediId,
		conversationId,
		runId,
		userTurn,
		assistantTurn,
		traceId,
		error,
		recovery,
		emitConversationCreated,
	} = opts;

	const userIso = isoFromTs(userTurn.ts);
	const failedIso = isoFromTs(Date.now());
	const assistantIso = assistantTurn ? isoFromTs(assistantTurn.ts) : failedIso;

	if (emitConversationCreated) {
		await safeRecord(
			platform,
			buildTediTurnRuntimeEvent({
				tediId,
				kind: "conversation.created",
				conversationId,
				eventIdRunId: runId,
				idSuffix: "conv-created",
				runtimeBackend: RUNTIME_BACKEND,
				traceId,
				createdAt: userIso,
			}),
			"conversation.created",
		);
	}

	// seq 0 — message.received (user turn)
	await safeRecord(
		platform,
		buildEvent({
			tediId,
			conversationId,
			runId,
			kind: "message.received",
			sequence: 0,
			createdAt: userIso,
			idSuffix: 0,
			payload: messagePayload(userTurn, "user"),
			traceId,
		}),
		"message.received",
	);

	// seq 1 — run.started
	await safeRecord(
		platform,
		buildEvent({
			tediId,
			conversationId,
			runId,
			kind: "run.started",
			sequence: 1,
			createdAt: userIso,
			idSuffix: 1,
			traceId,
		}),
		"run.started",
	);

	if (assistantTurn?.content.trim()) {
		await safeRecord(
			platform,
			buildEvent({
				tediId,
				conversationId,
				runId,
				kind: "message.completed",
				sequence: 2,
				createdAt: assistantIso,
				idSuffix: 2,
				payload: {
					role: "assistant",
					content: assistantTurn.content,
					error: error.slice(0, 2000),
					status: "failed",
				},
				traceId,
			}),
			"message.completed",
		);
	}

	// Classify the terminal cause from error text: absent prose alone does not
	// distinguish an empty model response from a runtime or tool failure.
	// Known observation failures retain their error without an unsupported reason.
	const failureReason = classifyRunTerminalReason({
		error,
		hasAssistantContent: Boolean(assistantTurn?.content.trim()),
		recovery: Boolean(recovery),
	});
	// seq 2/3 — run.failed (terminal failure boundary)
	await safeRecord(
		platform,
		buildEvent({
			tediId,
			conversationId,
			runId,
			kind: "run.failed",
			sequence: assistantTurn?.content.trim() ? 3 : 2,
			createdAt: failedIso,
			idSuffix: assistantTurn?.content.trim() ? 3 : 2,
			payload: {
				error: error.slice(0, 2000),
				...(failureReason === undefined ? {} : { reason: failureReason }),
				...(recovery ? { recovery } : {}),
			},
			traceId,
		}),
		"run.failed",
		opts.onTerminalDrop,
	);
}

// ── Reader: ledger-first messages_read fallback ──────────────────────────────

interface LedgerReaderExchange {
	descopeAccessKey: string;
	exchange: DescopeAccessKeyExchange;
}

// Module scope is per isolate, not per DO. Key by tedi so one tedi's JWT can
// never be replayed with another tedi's identity header.
const readerExchanges = new Map<string, LedgerReaderExchange>();

async function getReaderJwt(
	env: Cloudflare.Env,
	tediId: string,
): Promise<string | null> {
	if (!env.DESCOPE_PROJECT_ID) return null;
	const { descopeAccessKey } = await loadTediSecrets(env, tediId);
	let reader = readerExchanges.get(tediId);
	if (!reader || reader.descopeAccessKey !== descopeAccessKey) {
		reader = {
			descopeAccessKey,
			exchange: new DescopeAccessKeyExchange({
				descopeAccessKey,
				descopeProjectId: env.DESCOPE_PROJECT_ID,
				descopeBaseUrl: env.DESCOPE_BASE_URL || "https://auth.tedix.dev",
			}),
		};
		readerExchanges.set(tediId, reader);
	}
	return reader.exchange.getToken();
}

/**
 * Read durable ledger messages for one conversation.
 * Returns null if the call fails (caller falls back to DO state). A successful
 * empty transcript still carries the typed nullable compaction field.
 */
export async function readLedgerConversation(opts: {
	env: Cloudflare.Env;
	tediId: string;
	conversationId: string;
	limit?: number;
}): Promise<LedgerConversationRead | null> {
	if (!opts.env.API_URL) return null;
	try {
		const jwt = await getReaderJwt(opts.env, opts.tediId);
		if (!jwt) return null;
		const data = await callRpc<ReadMessagesOutput>(
			"cognitiveRuntime/readMessages",
			{
				tediId: opts.tediId,
				conversationId: opts.conversationId,
				limit: opts.limit ?? 50,
			},
			{
				apiUrl: opts.env.API_URL,
				headers: {
					Accept: "application/json",
					"Accept-Encoding": "identity",
					Authorization: `Bearer ${jwt}`,
					"X-Tedix-Tedi-Id": opts.tediId,
				},
			},
		);
		return {
			messages: data.messages,
			compaction: data.compaction,
		};
	} catch (err) {
		console.warn(
			"[isolate-ledger-mirror] readMessages error:",
			err instanceof Error ? err.message : err,
		);
		return null;
	}
}

/** One-RPC canonical D1 read mapped into the body-neutral session port. */
export async function readDurableLedgerState(opts: {
	env: Cloudflare.Env;
	tediId: string;
	conversationId: string;
	sessionKey: string;
	limit?: number;
}): Promise<TediSessionDurableState> {
	return ledgerReadToDurableState(
		opts.sessionKey,
		await readLedgerConversation(opts),
	);
}
