import {
	EMBEDDED_STREAM_CURSOR_REJECTED,
	EMBEDDED_STREAM_NOT_STARTED_EXPIRED,
} from "./embedded-contract";
import { newWebSocketRpcSession } from "capnweb";
import type {
	EmbeddedRootApi,
	EmbeddedSessionStub,
	EmbeddedTurnInput,
} from "./embedded-contract";
import { createSessionHub, type SessionLeaseHandle } from "./session-hub";
import type { RuntimeFrame } from "./runtime-frames";
import {
	createCanonicalProjectionWatcher,
	stableProjectionRevision,
} from "./canonical-projection";
import {
	createResumeWatermarkStore,
	type ResumeWatermarkStore,
} from "./resume-watermark";

export interface EmbeddedSessionCredentials {
	streamUrl: string;
	token: string;
}
export type EmbeddedSessionConnector = (
	credentials: EmbeddedSessionCredentials,
) => Promise<EmbeddedSessionStub>;

export interface EmbeddedClientObserver {
	onConnect?: () => void;
	onFrame?: (kind: RuntimeFrame["event"]["kind"]) => void;
	onRetry?: (input: {
		attempt: number;
		delayMs: number;
		error: unknown;
	}) => void;
}

/** The server's exact expiry signal (`EMBEDDED_SESSION_EXPIRED_MESSAGE`). */
function isSessionExpired(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.message === "Session expired" ||
			error.message === EMBEDDED_STREAM_NOT_STARTED_EXPIRED)
	);
}

/** Stop must settle during reconnect backoff, not after the next retry timer. */
function waitForReconnect(
	delayMs: number,
	signal?: AbortSignal,
): Promise<void> {
	if (signal?.aborted)
		return Promise.reject(new DOMException("Aborted", "AbortError"));
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(new DOMException("Aborted", "AbortError"));
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, delayMs);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export async function authenticateEmbeddedSocket(
	socket: string | WebSocket,
	token: string,
): Promise<EmbeddedSessionStub> {
	const root = newWebSocketRpcSession<EmbeddedRootApi>(socket);
	try {
		const session = await root.authenticate(token);
		return {
			ping: () => session.ping(),
			readTranscript: () => session.readTranscript(),
			readCompletedTurn: (id) => session.readCompletedTurn(id),
			stream: (input, subscriber) => session.stream(input, subscriber),
			cancel: (id) => session.cancel(id),
			listApprovals: () => session.listApprovals(),
			requestApproval: (description) => session.requestApproval(description),
			resolveApproval: (id, approved) => session.resolveApproval(id, approved),
			pin: (summary, page) => session.pin(summary, page),
			callPortableTool: (input) => session.callPortableTool(input),
			rankPortableTools: (input) => session.rankPortableTools(input),
			listConversationCapabilities: () =>
				session.listConversationCapabilities(),
			attachConversationCapability: (input) =>
				session.attachConversationCapability(input),
			detachConversationCapability: (referenceId) =>
				session.detachConversationCapability(referenceId),
			listConversationArtifactPins: () =>
				session.listConversationArtifactPins(),
			attachConversationArtifactPin: (input) =>
				session.attachConversationArtifactPin(input),
			detachConversationArtifactPin: (pinId) =>
				session.detachConversationArtifactPin(pinId),
			metrics: (input) => session.metrics(input),
			onRpcBroken: (callback) => root.onRpcBroken(callback),
			[Symbol.dispose]: () => {
				session[Symbol.dispose]();
				root[Symbol.dispose]();
			},
		};
	} catch (error) {
		root[Symbol.dispose]();
		throw error;
	}
}

async function connectWebSocket(
	config: EmbeddedSessionCredentials,
): Promise<EmbeddedSessionStub> {
	const url = new URL(config.streamUrl);
	url.pathname = "/chat/capn";
	url.protocol = "wss:";
	return authenticateEmbeddedSocket(url.href, config.token);
}

/**
 * The exact watermark key. The separator is NUL, which cannot occur in a scope
 * or a client request id, so no pair of `(scope, clientRequestId)` values can
 * produce the same key as a different pair.
 */
export function embeddedResumeWatermarkKey(
	scope: string,
	clientRequestId: string,
): string {
	return `${scope}\u0000${clientRequestId}`;
}

/**
 * Cross-invocation resume for the embedded lane.
 *
 * `stream()` already resumes across a dead socket WITHIN one turn: it holds the
 * last frame id the server issued and re-dials with it. What it could not do is
 * survive its own return — the retry loop's `cursor` is a local, so a second
 * `stream()` for the same turn (the widget re-entering a turn after the retry
 * budget ran out, after a teardown, or after the host remounted the thread)
 * re-opened COLD and the server honestly re-served the run from the beginning.
 *
 * The cursor is parked in the shared {@link createResumeWatermarkStore}, which
 * owns the clean-settle rule for both lanes and never interprets a position —
 * the embedded lane's opaque frame-id string fits it unchanged.
 *
 * ---------------------------------------------------------------------------
 * THE KEY
 * ---------------------------------------------------------------------------
 * A watermark is keyed by `scope \0 clientRequestId`, and the DEFAULT store is
 * created per `createEmbeddedClient` call. That default cannot collide across
 * tenants or conversations because it is never shared: one client instance is
 * bound to one `credentials()` closure, hence one embedded session — one
 * tenant, one subject, one conversation. `clientRequestId` is the only
 * remaining axis, and it is exactly the axis the server resolves a run id from
 * (`runId(scopedTurnKey(authority, clientRequestId))`), so a key that isolates
 * turns isolates every cursor the server would accept.
 *
 * A caller that WANTS one store across clients must name a `resumeScope`; the
 * option type refuses a shared store without one. The separator is NUL, which
 * cannot occur in a scope or a request id, so `"a" + "b:c"` can never collide
 * with `"a:b" + "c"`.
 *
 * Belt and braces: even a key collision could not deliver another tenant's
 * frames, because {@link EMBEDDED_STREAM_CURSOR_REJECTED} makes the capability
 * refuse any cursor outside the run it derived from ITS OWN authority. A
 * foreign cursor is rejected server-side; the client drops it and opens cold.
 */
export type EmbeddedResumeOptions =
	| {
			/** Share one store across clients. Requires an explicit scope. */
			resumeWatermarks: ResumeWatermarkStore<string>;
			resumeScope: string;
	  }
	| { resumeWatermarks?: undefined; resumeScope?: undefined };

export function createEmbeddedClient(
	credentials: () => Promise<EmbeddedSessionCredentials>,
	connect: EmbeddedSessionConnector = connectWebSocket,
	observer: EmbeddedClientObserver = {},
	resumeOptions: EmbeddedResumeOptions = {},
) {
	const watermarks =
		resumeOptions.resumeWatermarks ?? createResumeWatermarkStore<string>();
	const watermarkScope = resumeOptions.resumeScope ?? "embedded";
	const watermarkKey = (clientRequestId: string) =>
		embeddedResumeWatermarkKey(watermarkScope, clientRequestId);
	const hub = createSessionHub<EmbeddedSessionStub>({
		connect: async () => {
			const session = await connect(await credentials());
			observer.onConnect?.();
			return session;
		},
	});
	let lease = hub.lease();
	let disposed = false;
	/**
	 * Replace the shared lease, but only if the caller's own lease is still the
	 * current one.
	 *
	 * `lease` is ONE mutable slot shared by `operation()` and `stream()`, and
	 * both refresh by releasing and re-leasing. Releasing the last lease drops
	 * the hub refcount to zero, which tears the socket down — that is what makes
	 * the next `session()` dial fresh, and it is deliberate. What is not
	 * deliberate is doing it to somebody else's lease: a background `metrics()`
	 * or `listApprovals()` retry and a live `stream()` retry could each release
	 * the lease the OTHER had just acquired, driving the refcount to zero again
	 * and again and burning the stream's retry budget on failures it did not
	 * cause.
	 *
	 * Identity-checking the swap fixes that half. If a concurrent path already
	 * refreshed, this call adopts the session it created instead of destroying
	 * it. The remaining fact — that a refresh on a SHARED hub is global, so an
	 * expiry does end the current socket for everyone — is by design; `stream()`
	 * recovers from it explicitly with a free re-dial and a cursor resume.
	 */
	const refreshLease = (used: SessionLeaseHandle<EmbeddedSessionStub>) => {
		if (lease !== used) return lease;
		used.release();
		lease = hub.lease();
		return lease;
	};
	const operation = async <T>(
		call: (root: EmbeddedSessionStub) => Promise<T>,
	) => {
		const used = lease;
		try {
			return await call((await used.session()).root);
		} catch (error) {
			// A capability can expire before the socket itself breaks. The server's
			// exact Session expired error is emitted before dispatch, so credential
			// refresh and one retry are safe. Outcome-unknown socket failures are
			// never retried here because pin/approval calls may mutate durable state.
			if (!isSessionExpired(error)) throw error;
			// An expiry that lands after dispose must not resurrect the hub: the
			// re-lease would dial a socket with no reader and no one to close it.
			if (disposed) throw error;
			const active = refreshLease(used);
			return call((await active.session()).root);
		}
	};
	return {
		async stream(
			input: EmbeddedTurnInput,
			deliver: (frame: RuntimeFrame) => void | Promise<void>,
			signal?: AbortSignal,
		): Promise<void> {
			const watermark = watermarks.open(watermarkKey(input.clientRequestId));
			const seed = watermark.seed ?? undefined;
			let cursor: string | undefined = seed;
			// A seeded cursor means a previous invocation of THIS turn already
			// committed frames up to it, so the first dial is a resume, exactly as
			// a within-turn re-dial is. With no seed this is `false` and every
			// within-turn transition below is bit-for-bit what it was before.
			let attempted = seed !== undefined;
			// One free re-dial if the server refuses the seed: a parked watermark
			// whose run no longer resolves must cost a cold open, not the turn.
			let seedRejected = false;
			// Set only on the ONE throw this loop raises after a clean settle, so
			// the catch below can tell "the server closed the subscription early"
			// apart from every genuinely unclean exit it must disarm parking for.
			let endedClean = false;
			let terminal = false;
			let terminalError: Error | undefined;
			let terminalErrorRecoverable = false;
			// The credential (10 min TTL) can expire while a long turn is still
			// streaming. That is an expected refresh, not a failure: it gets ONE
			// immediate re-dial with fresh credentials that does not consume a
			// retry slot, and the turn resumes from the last committed cursor.
			let refreshedOnExpiry = false;
			const seen = new Set<string>();
			// The server replays from AFTER `lastEventId`, but a replay that
			// re-sends the seed frame itself must not be delivered twice across the
			// invocation seam — within a turn the same set already guarantees that.
			if (seed !== undefined) seen.add(seed);
			try {
				for (let retries = 0; retries < 5;) {
					if (disposed || signal?.aborted)
						throw new DOMException("Aborted", "AbortError");
					const used = lease;
					const previouslyAttempted: boolean = attempted;
					try {
						const { root } = await used.session();
						const resume = attempted;
						attempted = true;
						let delivery = Promise.resolve();
						await Promise.resolve(
							root.stream(
								{ ...input, resume, lastEventId: cursor },
								(frame) =>
									(delivery = delivery.then(async () => {
										if (disposed || signal?.aborted)
											throw new DOMException("Aborted", "AbortError");
										if (frame.id && seen.has(frame.id)) return;
										if (
											frame.event.kind === "error" &&
											frame.event.recoverable === true
										) {
											terminalError = new Error(
												typeof frame.event.message === "string"
													? frame.event.message
													: "Recoverable runtime stream error",
											);
											terminalErrorRecoverable = true;
											return;
										}
										observer.onFrame?.(frame.event.kind);
										await deliver(frame);
										if (frame.id) {
											seen.add(frame.id);
											cursor = frame.id;
											// The position the SERVER issued, recorded but not yet
											// trusted: only a clean settle can park it.
											watermark.advance(frame.id);
										}
										if (frame.event.kind === "done") terminal = true;
										if (frame.event.kind === "error") {
											terminalError = new Error(
												typeof frame.event.message === "string"
													? frame.event.message
													: "Tedi no pudo responder.",
											);
										}
									})),
							),
						).finally(() => delivery);
						if (terminalError) throw terminalError;
						// Reaching here is the store's clean settle, all three parts: the
						// subscribe RESOLVED, the delivery chain DRAINED (the `.finally`
						// above rejects if it did not), and no listener threw. The case
						// worth parking is the one just below — the subscription ended
						// early, so the run may still be live, and every position we
						// advanced to was actually delivered to the caller.
						watermark.settle();
						if (terminal) {
							// The turn is over: nothing is left to resume, so keep no stale
							// cursor for a request id the widget will never re-offer.
							watermark.reset();
							return;
						}
						endedClean = true;
						throw new Error("Subscription ended before completion");
					} catch (error) {
						// Every exit but the clean early end is unclean: a failed establish, a
						// dead socket, an abort, a runtime error frame, a listener that threw.
						if (!endedClean) watermark.unsettle();
						endedClean = false;
						if (disposed || signal?.aborted)
							throw new DOMException("Aborted", "AbortError");
						if (
							error instanceof Error &&
							error.message === EMBEDDED_STREAM_CURSOR_REJECTED &&
							cursor !== undefined &&
							cursor === seed &&
							!seedRejected
						) {
							// Only ever reachable from a PARKED seed: a cursor this turn
							// earned itself always belongs to the run the server derives.
							seedRejected = true;
							watermark.reset();
							seen.delete(seed);
							cursor = undefined;
							attempted = false;
							refreshLease(used);
							observer.onRetry?.({ attempt: retries + 1, delayMs: 0, error });
							continue;
						}
						if (
							error instanceof Error &&
							error.message === EMBEDDED_STREAM_NOT_STARTED_EXPIRED
						)
							attempted = previouslyAttempted;
						if (terminalError && !terminalErrorRecoverable) throw error;
						terminalError = undefined;
						terminalErrorRecoverable = false;
						// Discard broken/expired capabilities. Credentials are refreshed by the
						// bootstrap adapter; the exact client request id remains unchanged.
						// Identity-checked so a background `operation()` that already
						// refreshed does not get its fresh session torn down here.
						refreshLease(used);
						if (isSessionExpired(error) && !refreshedOnExpiry) {
							refreshedOnExpiry = true;
							observer.onRetry?.({ attempt: retries + 1, delayMs: 0, error });
							continue;
						}
						if (retries === 4) {
							// The callback may have died after the runtime durably finished.
							// Read only this request's terminal receipt; transcript text can
							// belong to an earlier, identical question.
							let completed: Awaited<
								ReturnType<EmbeddedSessionStub["readCompletedTurn"]>
							> = null;
							try {
								completed = await operation((root) =>
									root.readCompletedTurn(input.clientRequestId),
								);
							} catch {
								// Keep the original stream failure visible when the receipt
								// cannot be read.
							}
							if (disposed || signal?.aborted)
								throw new DOMException("Aborted", "AbortError");
							if (completed) {
								await deliver({
									id: null,
									event: { kind: "done", text: completed.text },
								});
								observer.onFrame?.("done");
								watermark.reset();
								return;
							}
							throw error;
						}
						const delayMs = Math.min(1000 * 2 ** retries, 8000);
						retries += 1;
						observer.onRetry?.({ attempt: retries, delayMs, error });
						await waitForReconnect(delayMs, signal);
					}
				}
			} finally {
				watermark.close();
			}
		},
		async cancel(id: string) {
			return operation((root) => root.cancel(id));
		},
		async listApprovals() {
			return operation((root) => root.listApprovals());
		},
		watchApprovals(
			deliver: (value: unknown) => void | Promise<void>,
			options: { idleMs?: number | false } = {},
		) {
			const watcher = createCanonicalProjectionWatcher({
				read: () => operation((root) => root.listApprovals()),
				revision: stableProjectionRevision,
				isActive: (value) => {
					if (!value || typeof value !== "object") return false;
					const data = (value as { data?: unknown }).data;
					return Array.isArray(data) && data.length > 0;
				},
				deliver,
				idleMs: options.idleMs,
			});
			void watcher.start();
			return watcher;
		},
		async requestApproval(description: string) {
			return operation((root) => root.requestApproval(description));
		},
		async resolveApproval(id: string, approved: boolean) {
			return operation((root) => root.resolveApproval(id, approved));
		},
		async pin(summary: string, page?: unknown) {
			return operation((root) => root.pin(summary, page));
		},
		async metrics(input: Parameters<EmbeddedSessionStub["metrics"]>[0]) {
			return operation((root) => root.metrics(input));
		},
		async callPortableTool(
			input: Parameters<EmbeddedSessionStub["callPortableTool"]>[0],
		) {
			return operation((root) => root.callPortableTool(input));
		},
		async rankPortableTools(
			input: Parameters<EmbeddedSessionStub["rankPortableTools"]>[0],
		) {
			return operation((root) => root.rankPortableTools(input));
		},
		async listConversationCapabilities() {
			return operation((root) => root.listConversationCapabilities());
		},
		async readTranscript() {
			return operation((root) => root.readTranscript());
		},
		async attachConversationCapability(
			input: Parameters<EmbeddedSessionStub["attachConversationCapability"]>[0],
		) {
			return operation((root) => root.attachConversationCapability(input));
		},
		async detachConversationCapability(referenceId: string) {
			return operation((root) =>
				root.detachConversationCapability(referenceId),
			);
		},
		async listConversationArtifactPins() {
			return operation((root) => root.listConversationArtifactPins());
		},
		async attachConversationArtifactPin(
			input: Parameters<
				EmbeddedSessionStub["attachConversationArtifactPin"]
			>[0],
		) {
			return operation((root) => root.attachConversationArtifactPin(input));
		},
		async detachConversationArtifactPin(pinId: string) {
			return operation((root) => root.detachConversationArtifactPin(pinId));
		},
		dispose() {
			if (!disposed) {
				disposed = true;
				lease.release();
			}
		},
	};
}
