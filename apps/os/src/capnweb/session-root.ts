/**
 * Cap'n Web browser-session capability root for OS Chat.
 *
 * A PROJECTION, not a product API: every capability method forwards to the
 * canonical `kernelRuntime` oRPC handlers in apps/api over the OS worker's
 * API_SERVICE binding. Cap'n Web adds no verb that oRPC lacks (ADR: no
 * browser-only business verbs) — it only changes the session transport, and
 * it is the only event transport (there is no SSE fallback lane). `worker.ts` gates the route server-side and `mount.ts`
 * refuses any upgrade that is not same-origin and authorizable in the host
 * tenant.
 *
 * Authority model (mirrors `worker.ts`'s `proxyApiRequest`): every forwarded
 * call carries the CALLER'S OWN credentials (Authorization/Cookie captured at
 * upgrade time) PLUS the host-asserted `X-Tedix-Tenant-Id`, so the HOSTNAME
 * decides the organization context and apps/api independently proves the
 * caller's membership in the asserted tenant. A client-supplied tenant
 * override can never enter: credential headers are allowlisted in `mount.ts`
 * and re-filtered here.
 *
 * Limits enforced in-root:
 * - {@link CAPN_MAX_LIVE_SUBSCRIPTIONS} live subscriptions per session.
 * - {@link MAX_MESSAGE_BYTES} serialized enqueue payload size.
 * - {@link RATE_LIMIT_CALLS} capability calls per {@link RATE_LIMIT_WINDOW_MS}
 *   (token bucket, continuous refill).
 * - Deterministic disposal: `SubscriptionCap` poll loops end when the client
 *   disposes the stub — capnweb invokes the target's `[Symbol.dispose]()`
 *   once every duplicate of the stub is disposed (verified against
 *   capnweb@0.11.1's README/types) — or when the session root disposes.
 *
 * Mutation contract: `enqueue` is NEVER retried internally. `callRpc`'s link
 * fails closed at retry 0, no retry option is passed, and no catch wraps the
 * call — an outcome-unknown transport failure propagates to the browser,
 * which owns the idempotency key and decides whether to re-send.
 *
 * Cursor contract: declared once in `./contract.ts` and implemented here.
 * `readRunEvents` is the canonical replay verb and its offsets are RUN-LOCAL,
 * so the wire cursor is an explicit `(runId, offset)` pair whose `offset` is
 * the NEXT offset to read. A cursor is applied only to the run it names; any
 * other run starts at 0. Absence of a cursor means "from the start of the
 * current run" — there is no negative sentinel, so the `nonnegative()` shape
 * of `readRunEvents.offset` can never reject a well-formed client.
 *
 * Contract binding: `CapnChatSession`, `ConversationCap` and `SubscriptionCap`
 * `implements` the interfaces in `./contract.ts`, which the browser derives its
 * stub types from. Drift between the halves is a compile error, and the
 * `_no*ExtraVerbs` assertions at the bottom of this file keep the RPC-visible
 * surface (everything public on an RpcTarget prototype is callable by the peer)
 * from growing silently.
 */

import {
	callRpc,
	type FetcherLike,
	serviceBindingFetch,
} from "@tedix/api-client/internal";
import {
	CancelHomeRunInputSchema,
	EnqueueHomeMessageInputSchema,
	type EnqueueHomeMessageOutput,
	type HomeRunSet,
	HomeRunSetSchema,
	ReadHomeRunEventsInputSchema,
	RespondHomeApprovalInputSchema,
} from "@tedix/api-contract/schemas/kernel-runtime";
import {
	type RuntimeStreamReadOutput,
	RuntimeStreamReadOutputSchema,
} from "@tedix/api-contract/schemas/runtime-submissions";
import { RpcTarget } from "capnweb";
import {
	CAPN_MAX_LIVE_SUBSCRIPTIONS,
	type CapnCancelOutput,
	type CapnConversationApi,
	type CapnConversationSnapshot,
	type CapnEventFrame,
	type CapnRespondApprovalParams,
	type CapnSessionApi,
	type CapnStreamCursor,
	type CapnSubscriber,
	type CapnSubscriptionApi,
} from "./contract";

// -----------------------------------------------------------------------------
// Limits (exported so tests and the decision record cite one source)
// -----------------------------------------------------------------------------

/** Max serialized `enqueue` payload size in bytes (64 KiB). */
export const MAX_MESSAGE_BYTES = 64 * 1024;
/** Token-bucket capacity: calls allowed per window. */
export const RATE_LIMIT_CALLS = 30;
/** Token-bucket window in milliseconds. */
export const RATE_LIMIT_WINDOW_MS = 10_000;
/** Mutation timeout above the API's 25s inline-turn budget (KERNEL_TURN_SOFT_DEADLINE_MS), including cold starts. */
export const CAPN_CHAT_MUTATION_TIMEOUT_MS = 45_000;
/** Long-poll `waitMs` passed to `readRunEvents` inside a subscription pump. */
export const SUBSCRIBE_POLL_WAIT_MS = 10_000;
/** Pause between pump turns when there is no active run or no new events. */
export const SUBSCRIBE_IDLE_DELAY_MS = 1_000;
/** Pause after a failed pump turn before the same turn is retried. */
export const SUBSCRIBE_ERROR_DELAY_MS = 2_000;
/**
 * Consecutive failed pump turns (upstream transport or a rejected receipt)
 * tolerated before the subscription gives up. A single failure used to end the
 * pump outright, which is the defect this bounds: apps/api restarting, one
 * long-poll timing out, or one malformed page killed a live subscription while
 * the browser's socket stayed healthy — so the UI went permanently stale with
 * no error anywhere.
 */
export const SUBSCRIBE_MAX_POLL_FAILURES = 5;
/**
 * Consecutive per-frame callback rejections tolerated before the SUBSCRIBER is
 * presumed gone. One rejection is not proof of a dead peer:
 * only a stub that keeps refusing delivery is.
 */
export const SUBSCRIBE_MAX_CALLBACK_FAILURES = 3;

// -----------------------------------------------------------------------------
// Validation helpers — zod schemas from @tedix/api-contract where they exist;
// derived slices otherwise (apps/os deliberately declares no direct zod dep).
// -----------------------------------------------------------------------------

type ParseResult<T> =
	| { success: true; data: T }
	| { success: false; error: unknown };
interface SafeParser<T> {
	safeParse(value: unknown): ParseResult<T>;
}

/** Non-empty string, reused for conversation ids, run ids, idempotency keys. */
const NonEmptyStringSchema: SafeParser<string> =
	CancelHomeRunInputSchema.shape.runId;
/** Optional non-negative integer offset — the readRunEvents offset shape. */
const OffsetSchema: SafeParser<number | undefined> =
	ReadHomeRunEventsInputSchema.shape.offset;
/**
 * Browser-facing enqueue payload: the canonical input minus the fields this
 * root pins itself (conversation from the cap, org from the host tenant
 * header, idempotency key as an explicit argument).
 */
const EnqueueInputSchema = EnqueueHomeMessageInputSchema.omit({
	organizationId: true,
	conversationId: true,
	idempotencyKey: true,
});
/** Approval params: canonical input minus the host-asserted organization. */
const RespondApprovalParamsSchema = RespondHomeApprovalInputSchema.omit({
	organizationId: true,
});
const CancelReasonSchema: SafeParser<string | undefined> =
	CancelHomeRunInputSchema.shape.reason;

/**
 * A refusal the PEER is allowed to read: contract violations and this root's
 * own limits. Every other failure (upstream oRPC text, binding-absent detail,
 * anything thrown by `callRpc`) is redacted by `mount.ts`'s `onSendError`,
 * which passes exactly this class through by name.
 */
export class CapnRequestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = CAPN_REQUEST_ERROR_NAME;
	}
}

/** Serialized `Error.name` of {@link CapnRequestError}; read by `mount.ts`. */
export const CAPN_REQUEST_ERROR_NAME = "CapnRequestError";

/**
 * Structural parse of the wire cursor. `null`/`undefined` is the legitimate
 * "I have nothing yet" value — the client never invents a sentinel offset, so
 * `readRunEvents`' `nonnegative()` offset shape has nothing to reject.
 */
function parseCursor(value: unknown): CapnStreamCursor | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== "object" || Array.isArray(value)) {
		throw new CapnRequestError(
			"Invalid cursor: expected {runId, offset} or null",
		);
	}
	const candidate = value as { runId?: unknown; offset?: unknown };
	const runId = parseOrThrow(
		NonEmptyStringSchema,
		candidate.runId,
		"cursor.runId",
	);
	const offset = parseOrThrow(OffsetSchema, candidate.offset, "cursor.offset");
	if (offset === undefined) {
		throw new CapnRequestError(
			"Invalid cursor.offset: expected a non-negative integer",
		);
	}
	return { runId, offset };
}

function parseOrThrow<T>(
	schema: SafeParser<T>,
	value: unknown,
	label: string,
): T {
	const result = schema.safeParse(value);
	if (!result.success) {
		const detail =
			result.error instanceof Error
				? result.error.message
				: String(result.error);
		throw new CapnRequestError(`Invalid ${label}: ${detail}`);
	}
	return result.data;
}

// -----------------------------------------------------------------------------
// Session plumbing (never RPC-exposed: held only in # private fields)
// -----------------------------------------------------------------------------

export interface CapnSessionEnv {
	/** Service binding to apps/api — the ONLY business-logic authority. */
	readonly API_SERVICE?: FetcherLike;
}

export interface CapnChatSessionInit {
	env: CapnSessionEnv;
	/**
	 * The host org's Descope tenant id resolved from the hostname by the OS
	 * worker. Asserted as `X-Tedix-Tenant-Id` on every forwarded call; apps/api
	 * proves membership and fails closed on a mismatch.
	 */
	hostTenantId: string | null;
	/**
	 * The caller's own forwarded credentials (Authorization/Cookie), captured
	 * from the upgrade request by `mount.ts`. Any tenant-override header is
	 * discarded here regardless of what the caller supplied.
	 */
	credentialHeaders: Record<string, string>;
	/** Injectable clock for the rate limiter (tests). */
	now?: () => number;
	/** Injectable pause for subscription pumps (tests). */
	sleep?: (ms: number) => Promise<void>;
}

/** Simple continuous-refill token bucket: RATE_LIMIT_CALLS per window. */
class TokenBucket {
	#tokens: number;
	#lastRefillAt: number;
	readonly #capacity: number;
	readonly #refillPerMs: number;
	readonly #now: () => number;

	constructor(capacity: number, windowMs: number, now: () => number) {
		this.#capacity = capacity;
		this.#tokens = capacity;
		this.#refillPerMs = capacity / windowMs;
		this.#now = now;
		this.#lastRefillAt = now();
	}

	take(): boolean {
		const at = this.#now();
		const elapsed = Math.max(0, at - this.#lastRefillAt);
		this.#tokens = Math.min(
			this.#capacity,
			this.#tokens + elapsed * this.#refillPerMs,
		);
		this.#lastRefillAt = at;
		if (this.#tokens < 1) return false;
		this.#tokens -= 1;
		return true;
	}
}

/**
 * Shared per-session internals. A plain class (NOT an RpcTarget): it is only
 * ever referenced from `#`-private fields, so it is unreachable over RPC.
 */
class SessionCore {
	readonly env: CapnSessionEnv;
	readonly hostTenantId: string | null;
	readonly credentialHeaders: Record<string, string>;
	readonly subscriptions = new Set<SubscriptionCap>();
	readonly sleep: (ms: number) => Promise<void>;
	disposed = false;
	readonly #bucket: TokenBucket;

	constructor(init: CapnChatSessionInit) {
		this.env = init.env;
		this.hostTenantId = init.hostTenantId;
		// Defense in depth beyond mount.ts's allowlist: the host asserts the
		// tenant, so a caller-supplied override never rides through (mirrors
		// proxyApiRequest's delete-then-set).
		this.credentialHeaders = Object.fromEntries(
			Object.entries(init.credentialHeaders).filter(
				([name]) => name.toLowerCase() !== "x-tedix-tenant-id",
			),
		);
		const now = init.now ?? (() => Date.now());
		this.sleep =
			init.sleep ??
			((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
		this.#bucket = new TokenBucket(RATE_LIMIT_CALLS, RATE_LIMIT_WINDOW_MS, now);
	}

	ensureLive(): void {
		if (this.disposed) {
			throw new CapnRequestError("Cap'n Web session is disposed");
		}
	}

	/** Per-session call rate cap over every RPC-visible capability method. */
	takeToken(): void {
		if (!this.#bucket.take()) {
			throw new CapnRequestError(
				`Rate limit exceeded: at most ${RATE_LIMIT_CALLS} calls per ${RATE_LIMIT_WINDOW_MS}ms per session`,
			);
		}
	}

	/**
	 * Forward one call to a canonical kernelRuntime handler in apps/api with
	 * the caller's credentials plus the host-asserted tenant. `retry` is only
	 * ever passed for read-only verbs; mutations take the fail-closed default
	 * of exactly one attempt.
	 */
	async call<T>(
		path: string,
		input: unknown,
		options: { retry?: number; timeoutMs?: number } = {},
	): Promise<T> {
		const service = this.env.API_SERVICE;
		if (!service) {
			throw new Error(
				"API_SERVICE binding is absent — the Cap'n Web projection requires the deployed API service",
			);
		}
		const headers: Record<string, string> = { ...this.credentialHeaders };
		if (this.hostTenantId) headers["X-Tedix-Tenant-Id"] = this.hostTenantId;
		return callRpc<T>(path, input, {
			apiUrl: "https://api",
			fetch: serviceBindingFetch(service),
			headers,
			timeoutMs: options.timeoutMs ?? 15_000,
			...(options.retry === undefined ? {} : { retry: options.retry }),
		});
	}

	/**
	 * Which run to follow next.
	 *
	 * `readRunSet` returns runs NEWEST-FIRST, so the run created immediately
	 * after `afterRunId` sits at its index minus one. Following that link
	 * instead of re-resolving "the current run" is what makes run rollover
	 * exact:
	 *
	 * - `afterRunId === null` (fresh subscribe): the active run, else the most
	 *   recent one, else nothing yet.
	 * - `afterRunId` is the newest run (index 0): nothing new — wait. The
	 *   pilot's version returned the newest run here, which is the run that
	 *   just closed, so the pump re-read it from offset 0 forever: an infinite
	 *   duplicate loop on every conversation whose run ended.
	 * - `afterRunId` fell off the newest page (a conversation that rolled >50
	 *   runs while this socket polled): follow the active run if there is one.
	 *   The live tail owes the client NOW; the durable transcript owns history
	 *   (the same doctrine the client's `since` storm guard encodes).
	 */
	async nextRunId(
		conversationId: string,
		afterRunId: string | null,
	): Promise<string | null> {
		const output = await this.call<{ runSet: unknown }>(
			"kernelRuntime/readRunSet",
			{ conversationId, summary: true },
			{ retry: 1 },
		);
		const runSet: HomeRunSet = parseOrThrow(
			HomeRunSetSchema,
			output.runSet,
			"readRunSet result",
		);
		if (afterRunId === null) {
			return runSet.activeRunIds[0] ?? runSet.runs[0]?.id ?? null;
		}
		const index = runSet.runs.findIndex((run) => run.id === afterRunId);
		if (index === -1) return runSet.activeRunIds[0] ?? null;
		return runSet.runs[index - 1]?.id ?? null;
	}

	/**
	 * One durable-offset page of a run's events — `readRunEvents`'s documented
	 * offset/nextOffset resume contract. Parsed because the receipt controls
	 * the pump loop.
	 */
	async readRunEventsPage(
		runId: string,
		offset: number,
		waitMs: number,
	): Promise<RuntimeStreamReadOutput> {
		const output = await this.call<unknown>(
			"kernelRuntime/readRunEvents",
			{ runId, offset, ...(waitMs > 0 ? { waitMs } : {}) },
			{ retry: 1, timeoutMs: waitMs + 15_000 },
		);
		return parseOrThrow(
			RuntimeStreamReadOutputSchema,
			output,
			"readRunEvents result",
		);
	}
}

// -----------------------------------------------------------------------------
// Subscription
// -----------------------------------------------------------------------------

/**
 * The subscriber stub has refused {@link SUBSCRIBE_MAX_CALLBACK_FAILURES}
 * consecutive deliveries: the peer is gone for real, so the pump ends. Private
 * to this module — it never crosses the wire.
 */
class SubscriberGoneError extends Error {
	constructor(cause: unknown) {
		super("Subscriber stub refused delivery repeatedly", { cause });
		this.name = "SubscriberGoneError";
	}
}

/**
 * A live subscription: a server-side poll loop over `readRunEvents` pushing
 * frames to the client's callback stub. The RPC surface is `dispose()` and
 * `isDisposed()`; the loop also ends deterministically when the client
 * disposes the returned stub (capnweb invokes `[Symbol.dispose]` on the
 * target) or when the session root disposes.
 */
export class SubscriptionCap extends RpcTarget implements CapnSubscriptionApi {
	#core: SessionCore;
	#conversationId: string;
	#callback: CapnSubscriber | null;
	#cursor: CapnStreamCursor | null;
	#stopped = false;
	#started = false;

	constructor(
		core: SessionCore,
		conversationId: string,
		callback: CapnSubscriber,
		cursor: CapnStreamCursor | null,
	) {
		super();
		this.#core = core;
		this.#conversationId = conversationId;
		this.#callback = callback;
		this.#cursor = cursor;
	}

	/**
	 * Started by `ConversationCap.subscribe` AFTER the session registry has
	 * adopted this cap. Starting it in the constructor let a pump that ended
	 * before registration insert a dead cap nothing could ever remove, burning
	 * one of CAPN_MAX_LIVE_SUBSCRIPTIONS for the life of the session.
	 *
	 * IDEMPOTENT because it is peer-callable: every public member of an
	 * RpcTarget is a verb the client can invoke, and each call used to spawn
	 * an INDEPENDENT concurrent pump on the same cap. Neither server limit
	 * caught it — `CAPN_MAX_LIVE_SUBSCRIPTIONS` counts caps (still one) and pumps
	 * never take a rate-limit token — so one authorized socket could fan out
	 * arbitrarily many long-polls into apps/api.
	 */
	start(): void {
		if (this.#started || this.#stopped) return;
		this.#started = true;
		void this.#pump();
	}

	isDisposed(): boolean {
		return this.#stopped;
	}

	/** Explicit stop: ends the poll loop and releases the retained callback. */
	dispose(): void {
		if (this.#stopped) return;
		this.#stopped = true;
		this.#core.subscriptions.delete(this);
		const callback = this.#callback;
		this.#callback = null;
		callback?.[Symbol.dispose]?.();
	}

	[Symbol.dispose](): void {
		this.dispose();
	}

	/**
	 * Poll loop. Follows the cursor's run (or the current one when the client
	 * has no cursor); when that run's stream closes it advances to the run
	 * created immediately after it and starts at offset 0. `SessionCore.nextRunId`
	 * links runs explicitly rather than re-asking for "the current run", so a
	 * closed run is never re-read and a run that opened and closed between polls
	 * is never skipped.
	 *
	 * LIVENESS: the pump survives transient trouble instead of ending on it.
	 * Every failure mode used to fall through one catch into `dispose()`, and
	 * because there is no server→client "your subscription died" signal on this
	 * wire, the browser kept a healthy socket, kept reporting "open", and went
	 * permanently stale. So:
	 *
	 * - A rejected per-frame delivery is LOGGED AND SKIPPED. Only
	 *   {@link SUBSCRIBE_MAX_CALLBACK_FAILURES} consecutive rejections prove the
	 *   peer is gone. A skipped frame is not lost: the client only advances its
	 *   resume cursor for frames it actually received, so its liveness probe
	 *   sees the lag and the reconnect's snapshot re-serves the gap.
	 * - A failed poll turn (upstream transport, a rejected receipt) sleeps
	 *   {@link SUBSCRIBE_ERROR_DELAY_MS} and retries the same turn. Only
	 *   {@link SUBSCRIBE_MAX_POLL_FAILURES} consecutive failures end the pump.
	 *
	 * Both counters reset on the first success, so a long-lived subscription
	 * that hiccups hourly never accumulates its way to death. When the pump does
	 * end, the client's contract is unchanged: reacquire the capability and
	 * resubscribe from the last `nextOffset` it received — which its own
	 * watchdog (`capn-chat-machine.ts`) now enforces rather than assumes.
	 */
	async #pump(): Promise<void> {
		let runId: string | null = this.#cursor?.runId ?? null;
		let offset = this.#cursor?.offset ?? 0;
		/** The run the follow-chain advances FROM; null until one is chosen. */
		let previousRunId: string | null = null;
		let pollFailures = 0;
		let callbackFailures = 0;
		try {
			while (!this.#stopped && !this.#core.disposed) {
				try {
					if (runId === null) {
						runId = await this.#core.nextRunId(
							this.#conversationId,
							previousRunId,
						);
						if (this.#stopped || this.#core.disposed) return;
						pollFailures = 0;
						if (runId === null) {
							await this.#core.sleep(SUBSCRIBE_IDLE_DELAY_MS);
							continue;
						}
						offset = 0;
					}
					const page = await this.#core.readRunEventsPage(
						runId,
						offset,
						SUBSCRIBE_POLL_WAIT_MS,
					);
					if (this.#stopped || this.#core.disposed) return;
					pollFailures = 0;
					for (const [index, event] of page.events.entries()) {
						const callback = this.#callback;
						if (callback === null) return;
						const frameOffset = page.stream.offset + index;
						try {
							// Awaited for backpressure.
							await callback({
								conversationId: this.#conversationId,
								runId,
								offset: frameOffset,
								nextOffset: frameOffset + 1,
								event,
							});
							callbackFailures = 0;
						} catch (error) {
							callbackFailures += 1;
							if (callbackFailures >= SUBSCRIBE_MAX_CALLBACK_FAILURES) {
								throw new SubscriberGoneError(error);
							}
							console.warn(
								`capnweb subscription delivery failed (${callbackFailures}/${SUBSCRIBE_MAX_CALLBACK_FAILURES}): ${(error as Error).message}`,
							);
						}
						if (this.#stopped || this.#core.disposed) return;
					}
					offset = page.stream.nextOffset;
					if (page.stream.closed) {
						previousRunId = runId;
						runId = null;
						await this.#core.sleep(SUBSCRIBE_IDLE_DELAY_MS);
					} else if (page.events.length === 0) {
						// The long-poll may return early; pace the loop regardless.
						await this.#core.sleep(SUBSCRIBE_IDLE_DELAY_MS);
					}
				} catch (error) {
					if (error instanceof SubscriberGoneError) throw error;
					pollFailures += 1;
					if (pollFailures >= SUBSCRIBE_MAX_POLL_FAILURES) throw error;
					console.warn(
						`capnweb subscription poll failed (${pollFailures}/${SUBSCRIBE_MAX_POLL_FAILURES}): ${(error as Error).message}`,
					);
					await this.#core.sleep(SUBSCRIBE_ERROR_DELAY_MS);
				}
			}
		} catch (error) {
			console.error(
				`capnweb subscription pump ended: ${(error as Error).message}`,
			);
		} finally {
			this.dispose();
		}
	}
}

// -----------------------------------------------------------------------------
// Conversation capability
// -----------------------------------------------------------------------------

export class ConversationCap extends RpcTarget implements CapnConversationApi {
	#core: SessionCore;
	#conversationId: string;

	constructor(core: SessionCore, conversationId: string) {
		super();
		this.#core = core;
		this.#conversationId = conversationId;
	}

	/**
	 * Durable events from `cursor`, plus the cursor to subscribe with next.
	 *
	 * A cursor is applied ONLY to the run it names: when the conversation has
	 * moved on to a different run, the client has seen none of it, so the read
	 * starts at 0. Absence of a cursor means the same thing for a first
	 * connection. Event-only by design — the transcript is served by
	 * `kernelRuntime/readMessages` on the oRPC path, and carrying it here cost
	 * an upstream round trip per reconnect that no client ever read.
	 *
	 * MEASUREMENT: this verb is the replay path — every reconnect and every
	 * liveness probe pays it. The client records its local replay metric, while
	 * the server emits one bounded structured record only when it actually
	 * serves events. Zero-event health probes stay silent.
	 */
	async snapshot(
		cursor?: CapnStreamCursor | null,
	): Promise<CapnConversationSnapshot> {
		this.#core.ensureLive();
		this.#core.takeToken();
		const resume = parseCursor(cursor);
		const runId =
			resume?.runId ?? (await this.#core.nextRunId(this.#conversationId, null));
		if (runId === null) {
			return {
				conversationId: this.#conversationId,
				runId: null,
				events: [],
				cursor: null,
				stream: null,
			};
		}
		// The cursor's own run is honored even when a newer run already exists:
		// finishing it is what makes the subsequent subscribe gap-free, and the
		// pump rolls forward from there. `resume === null` means offset 0 of the
		// current run — the first-connection case.
		const offset = resume?.offset ?? 0;
		const page = await this.#core.readRunEventsPage(runId, offset, 0);
		const events: CapnEventFrame[] = page.events.map((event, index) => {
			const frameOffset = page.stream.offset + index;
			return {
				conversationId: this.#conversationId,
				runId,
				offset: frameOffset,
				nextOffset: frameOffset + 1,
				event,
			};
		});
		if (events.length > 0) {
			console.info("[capnweb] conversation snapshot replay served", {
				conversationId: this.#conversationId,
				runId,
				fromOffset: offset,
				nextOffset: page.stream.nextOffset,
				eventCount: events.length,
				closed: page.stream.closed,
			});
		}
		return {
			conversationId: this.#conversationId,
			runId,
			events,
			cursor: { runId, offset: page.stream.nextOffset },
			stream: page.stream,
		};
	}

	/**
	 * Live tail from `cursor`, rolling forward across run boundaries. Returns a
	 * `SubscriptionCap`; disposing the stub (or calling `dispose()`) stops the
	 * loop deterministically.
	 */
	subscribe(
		callback: CapnSubscriber,
		cursor?: CapnStreamCursor | null,
	): SubscriptionCap {
		this.#core.ensureLive();
		this.#core.takeToken();
		const resume = parseCursor(cursor);
		if (typeof callback !== "function") {
			throw new CapnRequestError(
				"Invalid subscribe callback: expected a function stub",
			);
		}
		if (this.#core.subscriptions.size >= CAPN_MAX_LIVE_SUBSCRIPTIONS) {
			throw new CapnRequestError(
				`Subscription limit exceeded: at most ${CAPN_MAX_LIVE_SUBSCRIPTIONS} live subscriptions per session`,
			);
		}
		// Params stubs are implicitly disposed when this call returns; dup() so
		// the pump's retained copy outlives the subscribe() call (capnweb's
		// documented callback-retention rule). Local plain functions (tests)
		// have no dup and pass through.
		const retained =
			typeof callback.dup === "function" ? callback.dup() : callback;
		const subscription = new SubscriptionCap(
			this.#core,
			this.#conversationId,
			retained,
			resume,
		);
		// Register BEFORE the pump can end: a pump that disposes itself first
		// would otherwise leave a dead entry in the registry forever.
		this.#core.subscriptions.add(subscription);
		subscription.start();
		return subscription;
	}

	/**
	 * Record one Home turn via `kernelRuntime/enqueueMessage`. NEVER retried
	 * internally and never caught: an outcome-unknown failure surfaces to the
	 * caller, who owns `idempotencyKey` and decides whether to re-send.
	 */
	async enqueue(
		input: unknown,
		idempotencyKey: string,
	): Promise<EnqueueHomeMessageOutput> {
		this.#core.ensureLive();
		this.#core.takeToken();
		const key = parseOrThrow(
			NonEmptyStringSchema,
			idempotencyKey,
			"idempotencyKey",
		);
		const payload = parseOrThrow(
			EnqueueInputSchema as SafeParser<Record<string, unknown>>,
			input,
			"enqueue input",
		);
		const size = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
		if (size > MAX_MESSAGE_BYTES) {
			throw new CapnRequestError(
				`Message too large: ${size} bytes exceeds the ${MAX_MESSAGE_BYTES}-byte cap`,
			);
		}
		return this.#core.call<EnqueueHomeMessageOutput>(
			"kernelRuntime/enqueueMessage",
			{ ...payload, conversationId: this.#conversationId, idempotencyKey: key },
			{ timeoutMs: CAPN_CHAT_MUTATION_TIMEOUT_MS },
		);
	}

	/** Cancel an active run via `kernelRuntime/cancelRun` (single attempt). */
	async cancel(runId: string, reason?: string): Promise<CapnCancelOutput> {
		this.#core.ensureLive();
		this.#core.takeToken();
		const id = parseOrThrow(NonEmptyStringSchema, runId, "runId");
		const note = parseOrThrow(CancelReasonSchema, reason, "reason");
		return this.#core.call<CapnCancelOutput>("kernelRuntime/cancelRun", {
			runId: id,
			...(note === undefined ? {} : { reason: note }),
		});
	}

	/**
	 * Resolve what a run is waiting on via `kernelRuntime/respondApproval` —
	 * THE Home approval surface (single attempt).
	 */
	async respondApproval(params: CapnRespondApprovalParams): Promise<unknown> {
		this.#core.ensureLive();
		this.#core.takeToken();
		const payload = parseOrThrow(
			RespondApprovalParamsSchema as SafeParser<Record<string, unknown>>,
			params,
			"respondApproval params",
		);
		return this.#core.call<unknown>("kernelRuntime/respondApproval", payload);
	}

	// No [Symbol.dispose]: subscriptions are owned by the SESSION registry and
	// each SubscriptionCap disposes itself; dropping a conversation stub must
	// not kill a subscription the client still holds a live stub for. The
	// session root's disposer is the deterministic teardown for everything.
}

// -----------------------------------------------------------------------------
// Session root
// -----------------------------------------------------------------------------

/**
 * The capability root handed to `newWorkersWebSocketRpcResponse` by `mount.ts`.
 * One
 * instance per WebSocket session, bound at construction to the host-resolved
 * tenant and the caller's forwarded credentials.
 */
export class CapnChatSession extends RpcTarget implements CapnSessionApi {
	#core: SessionCore;

	constructor(init: CapnChatSessionInit) {
		super();
		this.#core = new SessionCore(init);
	}

	/** Proves the session and its caller authority still reach this Worker. */
	async ping(): Promise<void> {
		this.#core.ensureLive();
	}

	/** Open a conversation capability. All authority stays with apps/api. */
	openConversation(conversationId: string): ConversationCap {
		this.#core.ensureLive();
		this.#core.takeToken();
		const id = parseOrThrow(
			NonEmptyStringSchema,
			conversationId,
			"conversationId",
		);
		return new ConversationCap(this.#core, id);
	}

	/**
	 * Deterministic teardown: capnweb invokes this when the session's main
	 * stub is disposed (WebSocket close included) — every live subscription
	 * pump ends and retained callback stubs are released.
	 */
	[Symbol.dispose](): void {
		this.#core.disposed = true;
		// Set iteration is deletion-safe: each dispose() removes its own entry.
		for (const subscription of this.#core.subscriptions) {
			subscription.dispose();
		}
	}
}

// -----------------------------------------------------------------------------
// Compile-time RPC-surface conformance
// -----------------------------------------------------------------------------
//
// `implements` above proves each class SATISFIES the contract. These prove the
// converse — that no class exposes a verb the contract does not declare. Every
// public member of an RpcTarget prototype is callable by the peer, so an
// undeclared method is an undeclared authority; this turns adding one into a
// type error instead of a silent widening of the wire.

type ExtraVerbs<TClass, TContract> = Exclude<
	keyof TClass,
	keyof TContract | keyof RpcTarget
>;

const _noExtraSessionVerbs: [
	ExtraVerbs<CapnChatSession, CapnSessionApi>,
] extends [never]
	? true
	: never = true;
const _noExtraConversationVerbs: [
	ExtraVerbs<ConversationCap, CapnConversationApi>,
] extends [never]
	? true
	: never = true;
// `start()` is the registry-ordering hook ConversationCap calls in-process; it
// is deliberately part of the subscription's declared surface.
const _noExtraSubscriptionVerbs: [
	Exclude<ExtraVerbs<SubscriptionCap, CapnSubscriptionApi>, "start">,
] extends [never]
	? true
	: never = true;

void _noExtraSessionVerbs;
void _noExtraConversationVerbs;
void _noExtraSubscriptionVerbs;
