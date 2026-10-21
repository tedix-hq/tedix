import {
	homePayloadFromTask,
	type HomeRunEventsPage,
	HOME_RUN_EVENTS_START,
	HOME_RUN_EVENTS_PAGE,
	HOME_MESSAGES_PAGE,
	HOME_RUN_SET_PAGE,
	HOME_RUN_SET_RUN_KEYS,
	HOME_RUN_SET_METADATA_KEYS,
	HOME_CHILD_TREE_NODE_KEYS,
	parseMcpResponsePayload,
	isExpiredSessionError,
	unwrapToolResult,
	parseHomeRunEventsPage,
} from "./home-payload";
import {
	resolveCliDestructiveElicitation,
	resolveCliTaskInputResponses,
} from "./home-elicitation";
import { isRateLimitError, rateLimitRetryAfterMs } from "./home-rate-limit";
import { normalizeCodeResult } from "./code-result";
import {
	extractWWWAuthenticateParams,
	type JSONRPCMessage,
	InsufficientScopeError,
	type OAuthClientProvider,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { McpCreateTaskResultSchema } from "@tedix/api-contract/schemas/mcp-tasks";
import {
	MCP_CLIENT_CAPABILITIES_META_KEY,
	MCP_CLIENT_INFO_META_KEY,
	MCP_METHOD_HEADER,
	MCP_MODERN_PROTOCOL_VERSION,
	MCP_NAME_REQUIRED_METHODS,
	MCP_NAME_HEADER,
	MCP_PROTOCOL_VERSION_HEADER,
	MCP_PROTOCOL_VERSION_META_KEY,
	MCP_TASKS_EXTENSION,
	mcpRequestTargetName,
} from "@tedix/mcp-shared/protocol";
import {
	formatTraceparent,
	parseTraceparentTraceId,
	resolveInboundTracestate,
} from "@tedix/mcp-shared/trace-context";
import {
	assertMcpTaskAck,
	McpTaskResponseError,
	parseMcpTaskState,
	pollMcpTask,
} from "@tedix/mcp-shared/task-polling";
import type { McpTaskState } from "@tedix/mcp-shared/tasks";
import { type DiscoveryCache, isStaleDiscoveryError } from "./discovery-cache";
import { isConnectionError } from "./operator/runtime-errors";
import {
	resendPreDispatchToolRefusals,
	retryRateLimitedPosts,
} from "./gateway-retry";
import type { SessionRefreshOutcome } from "./oauth-provider";
import { CLI_VERSION } from "./shared";
import { isRecord } from "@tedix/api-contract/utils/is-record";
const MAX_SYNC_INPUT_ROUNDS = 8;
const CLI_CLIENT_INFO = { name: "tedix-cli", version: CLI_VERSION };
const CLI_CLIENT_CAPABILITIES = {
	elicitation: { form: {} },
	extensions: { [MCP_TASKS_EXTENSION]: {} },
};
type FetchLike = (
	...args: Parameters<typeof fetch>
) => ReturnType<typeof fetch>;

/** One request-local receipt shared by HTTP and MCP SEP-414 metadata. */
export function createCliRequestTrace(
	inputHeaders: Record<string, string>,
	inputMeta?: unknown,
): {
	traceId: string;
	headers: Record<string, string>;
	meta: Record<string, unknown>;
} {
	const headers = new Headers(inputHeaders);
	const meta = isRecord(inputMeta) ? inputMeta : {};
	const validParent = (value: unknown): string | undefined => {
		if (typeof value !== "string") return undefined;
		const parent = value.trim().toLowerCase();
		return parseTraceparentTraceId(parent) &&
			parent.split("-")[2] !== "0000000000000000"
			? parent
			: undefined;
	};
	const parent =
		validParent(headers.get("traceparent")) ?? validParent(meta.traceparent);
	const legacyId = headers.get("x-trace-id") ?? headers.get("x-tedix-trace-id");
	const legacyParent =
		legacyId &&
		/^(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.test(
			legacyId,
		)
			? formatTraceparent(legacyId)
			: null;
	const traceId =
		(parent && parseTraceparentTraceId(parent)) ||
		parseTraceparentTraceId(legacyParent) ||
		crypto.randomUUID();
	const traceparent = parent ?? formatTraceparent(traceId)!;
	const tracestate = resolveInboundTracestate(headers, meta);
	headers.set("traceparent", traceparent);
	headers.set("x-trace-id", traceId);
	headers.set("x-tedix-trace-id", traceId);
	if (tracestate) headers.set("tracestate", tracestate);
	return {
		traceId,
		headers: Object.fromEntries(headers.entries()),
		meta: { ...meta, traceparent, ...(tracestate ? { tracestate } : {}) },
	};
}

export const DEFAULT_TEDIX_MCP_URL = "https://tedix-unified.mcp.tedix.dev/mcp";

/** Minimal MCP client surface the home client depends on (test seam). */
export interface McpClientLike {
	callTool(
		params: {
			name: string;
			arguments: Record<string, unknown>;
		},
		options: {
			resetTimeoutOnProgress: boolean;
			signal?: AbortSignal;
			timeout: number;
		},
	): Promise<unknown>;
	close(): Promise<void>;
}

export interface TedixHomeClientOptions {
	/** Override how the MCP connection is established (tests inject a fake). */
	connect?: () => Promise<McpClientLike>;
	/** Override raw modern Task requests (tests inject a fake). */
	fetch?: FetchLike;
	headers: Record<string, string>;
	oauthProvider?: OAuthClientProvider & {
		authorizeInteractive?: (
			options: Parameters<
				typeof import("@modelcontextprotocol/client").auth
			>[1],
		) => Promise<void>;
		/**
		 * Renew the session from its refresh token. Duck-typed rather than importing
		 * WorkspaceOAuthProvider so the transport keeps no dependency on the
		 * concrete credential store.
		 */
		refreshSession?: () => Promise<SessionRefreshOutcome>;
		authorizeScopeChallenge?: (requiredScope: string) => Promise<void>;
	};
	timeoutMs?: number;
	url: string;
	/** Reuse a recent `server/discover` answer across CLI processes. */
	discoveryCache?: DiscoveryCache;
}

/** One bounded typed call; never shared by unrelated callers or renewed by progress. */
class NativeCallScope {
	readonly controller = new AbortController();
	readonly signal = this.controller.signal;
	readonly deadlineAt: number;
	readonly maxBytes: number;
	#budget: { bytes: number };
	#timer: ReturnType<typeof setTimeout>;
	#parent: AbortSignal | undefined;
	#parentAbort: () => void;
	#cancellations = new Set<() => void>();
	constructor(
		options: McpCallOptions,
		timeoutMs: number,
		budget = { bytes: 0 },
	) {
		this.#budget = budget;
		const duration = options.timeoutMs ?? timeoutMs;
		const ceiling = options.maxResponseBytes!;
		if (
			!Number.isSafeInteger(ceiling) ||
			ceiling < 1 ||
			ceiling > 4 * 1024 * 1024 ||
			!Number.isFinite(duration) ||
			duration <= 0 ||
			(options.deadlineAt !== undefined && !Number.isFinite(options.deadlineAt))
		)
			throw new Error("Invalid bounded native call options");
		this.maxBytes = ceiling;
		this.deadlineAt = Math.min(
			Date.now() + duration,
			options.deadlineAt ?? Infinity,
		);
		this.#parent = options.signal;
		this.#parentAbort = () =>
			this.abort(
				options.signal?.reason ?? new DOMException("Aborted", "AbortError"),
			);
		options.signal?.addEventListener("abort", this.#parentAbort, {
			once: true,
		});
		if (options.signal?.aborted) this.#parentAbort();
		this.#timer = setTimeout(
			() =>
				this.abort(
					new DOMException("Native call deadline elapsed", "TimeoutError"),
				),
			Math.max(0, this.deadlineAt - Date.now()),
		);
		try {
			this.guard();
		} catch (error) {
			this.close();
			throw error;
		}
	}
	abort(reason: unknown): void {
		if (this.signal.aborted) return;
		this.controller.abort(reason);
		for (const cancel of [...this.#cancellations]) cancel();
	}
	guard(): void {
		if (Date.now() >= this.deadlineAt)
			this.abort(
				new DOMException("Native call deadline elapsed", "TimeoutError"),
			);
		this.signal.throwIfAborted();
	}
	charge(bytes: number): void {
		this.guard();
		if (
			!Number.isSafeInteger(bytes) ||
			bytes < 0 ||
			bytes > this.maxBytes - this.#budget.bytes
		) {
			this.abort(
				new Error(
					"Native response exceeds call-local byte limit; persistence is unknown",
				),
			);
			this.guard();
		}
		this.#budget.bytes += bytes;
	}
	async wait<T>(operation: Promise<T>): Promise<T> {
		// Observe an already-started owned operation even when the guard is sticky.
		void operation.catch(() => {});
		this.guard();
		let rejectAbort: () => void = () => {};
		const aborted = new Promise<never>((_, reject) => {
			rejectAbort = () => reject(this.signal.reason);
			this.signal.addEventListener("abort", rejectAbort, { once: true });
			if (this.signal.aborted) rejectAbort();
		});
		try {
			const value = await Promise.race([operation, aborted]);
			this.guard();
			return value;
		} finally {
			this.signal.removeEventListener("abort", rejectAbort);
		}
	}
	cancellationScope(): NativeCallScope | undefined {
		if (Date.now() >= this.deadlineAt || this.#budget.bytes >= this.maxBytes)
			return undefined;
		return new NativeCallScope(
			{
				deadlineAt: this.deadlineAt,
				timeoutMs: Math.max(1, this.deadlineAt - Date.now()),
				maxResponseBytes: this.maxBytes,
			},
			Math.max(1, this.deadlineAt - Date.now()),
			this.#budget,
		);
	}
	async receive(fetching: Promise<Response>): Promise<Response> {
		return this.wait(
			fetching.then((response) => {
				if (this.signal.aborted) {
					void response.body?.cancel(this.signal.reason).catch(() => {});
					this.guard();
				}
				return this.wrap(response);
			}),
		);
	}
	wrap(response: Response): Response {
		this.guard();
		if (!response.body) return response;
		const reader = response.body.getReader();
		const utf8 = new TextDecoder("utf-8", { fatal: true });
		let done = false;
		let controller: ReadableStreamDefaultController<Uint8Array>;
		const release = () => {
			this.#cancellations.delete(cancel);
		};
		const cancel = () => {
			if (done) return;
			done = true;
			void reader.cancel(this.signal.reason).catch(() => {});
			controller.error(this.signal.reason);
			release();
		};
		const stream = new ReadableStream<Uint8Array>({
			start: (c) => {
				controller = c;
				this.#cancellations.add(cancel);
				if (this.signal.aborted) cancel();
			},
			pull: async (c) => {
				try {
					const chunk = await this.wait(reader.read());
					if (done) return;
					if (chunk.done) {
						utf8.decode();
						done = true;
						release();
						c.close();
						return;
					}
					this.charge(chunk.value.byteLength);
					utf8.decode(chunk.value, { stream: true });
					c.enqueue(chunk.value);
				} catch (error) {
					if (!done) {
						done = true;
						void reader.cancel(error).catch(() => {});
						release();
						c.error(error);
					}
				}
			},
			cancel: (reason) => {
				done = true;
				release();
				return reader.cancel(reason);
			},
		});
		const bounded = new Response(stream, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
		for (const key of ["url", "redirected", "type"] as const)
			Object.defineProperty(bounded, key, { value: response[key] });
		return bounded;
	}
	close(): void {
		clearTimeout(this.#timer);
		this.#parent?.removeEventListener("abort", this.#parentAbort);
		this.abort(new DOMException("Native call finished", "AbortError"));
	}
}

export interface McpCallOptions {
	/** Explicit approval for this call's MRTR and Task input rounds only. */
	destructiveApprovalReason?: string;
	/** Fresh command-local identity; completed protocol capability only. */
	protocolSequence?: object;
	/** Raw bytes across every input/task response in this logical call. */
	maxResponseBytes?: number;
	/** Absolute caller deadline; task/input/progress cannot renew it. */
	deadlineAt?: number;
	timeoutMs?: number;
	/** Set internally so one expired-session renewal never retries twice. */
	retriedAfterSessionRefresh?: boolean;
	/** Abort a task-backed call and request upstream tasks/cancel. */
	signal?: AbortSignal;
	/** Retry this idempotent read once when the shared MCP connection drops. */
	retryable?: boolean;
}

export interface AskHomeInput {
	content: string;
	conversationId: string;
	delegateToTediId?: string;
	/** Exact verify command the delegated tedi must run and quote before it reports. */
	verifyCommand?: string;
	metadata?: Record<string, unknown>;
}

export interface ReadHomeMessagesInput {
	conversationId: string;
	cursor?: string;
	limit?: number;
}

export interface ReadHomeRunSetInput {
	conversationId: string;
	limit?: number;
}

export interface ListHomeConversationsInput {
	channel?: string;
	cursor?: string;
	includeArchived?: boolean;
	limit?: number;
	search?: string;
}

export interface ListKernelTraceBundlesInput {
	harnessVersionId?: string;
	limit?: number;
	runId?: string;
}

export interface ReadChildRunEvidenceInput {
	artifactLimit?: number;
	childRunId: string;
	delegatedTediId: string;
	limit?: number;
}

export interface ReadChildRunTreeInput {
	conversationId: string;
	limit?: number;
}

export interface ReadHomeRunEventsInput {
	childRunId?: string;
	delegatedTediId?: string;
	homeRunId: string;
	/** Array-index resume cursor as a string. Omit or "0" reads from the start. */
	offset?: string;
	/** Long-poll hint in milliseconds. The server returns sooner when new events arrive. */
	waitMs?: number;
	/** Maximum events in one page. Bounded so the gateway does not truncate the result. */
	limit?: number;
}

export class TedixHomeClient {
	readonly #options: Required<
		Pick<TedixHomeClientOptions, "timeoutMs" | "url">
	> &
		Pick<TedixHomeClientOptions, "headers">;

	readonly #connectFn: (() => Promise<McpClientLike>) | undefined;
	readonly #fetch: FetchLike;
	readonly #oauthProvider: TedixHomeClientOptions["oauthProvider"];
	readonly #transport: StreamableHTTPClientTransport | undefined;
	readonly #nativeScopes = new Map<string, NativeCallScope>();
	readonly #nativeResumptionTokens = new Map<string, string>();
	readonly #nativeResumptions = new Map<
		string,
		Map<string, NativeCallScope | undefined>
	>();
	#transportStarted: Promise<void> | undefined;
	#oauthFlow: Promise<void> | undefined;
	#pendingTransport = new Map<
		string,
		{ resolve: (payload: { error?: unknown; result?: unknown }) => void }
	>();
	#modernDiscovery: Promise<{ supportsTasks: boolean }> | undefined;
	#discoveryCache: DiscoveryCache | undefined;
	#discoveryFromCache = false;
	#nativeProtocols = new WeakMap<object, { supportsTasks: boolean }>();
	#destructiveApprovalReason: string | undefined;
	#destructiveCallTail: Promise<void> = Promise.resolve();

	constructor(options: TedixHomeClientOptions) {
		// The local MCP edge resolves the app from the host. Supply X-Tedix-Host
		// for loopback URLs unless the caller already set it.
		// A client keeps its selected gateway binding; caller mutation cannot retarget it.
		let headers = Object.freeze({ ...options.headers });
		try {
			const host = new URL(options.url).hostname;
			if (
				(host === "localhost" || host === "127.0.0.1") &&
				!headers["X-Tedix-Host"]
			) {
				headers = {
					...headers,
					"X-Tedix-Host": "tedix-unified.mcp.tedix.tech",
				};
			}
		} catch {
			// Malformed URL — let the transport surface the real error.
		}
		this.#options = {
			headers,
			timeoutMs: options.timeoutMs ?? 180_000,
			url: options.url,
		};
		this.#fetch = retryRateLimitedPosts(options.fetch ?? fetch);
		this.#discoveryCache = options.discoveryCache;
		this.#oauthProvider = options.oauthProvider;
		this.#transport = options.oauthProvider
			? new StreamableHTTPClientTransport(new URL(this.#options.url), {
					authProvider: {
						token: async () =>
							(await options.oauthProvider?.tokens())?.access_token,
						onUnauthorized: async ({ response, serverUrl, fetchFn }) => {
							// Own the entire transaction, including verifier creation, not
							// just the callback. Parallel pollers must never run auth twice.
							await this.#runOAuthTransaction(async () => {
								const provider = options.oauthProvider!;
								const tokens = await provider.tokens();
								if (tokens?.refresh_token && provider.refreshSession) {
									const outcome = await provider.refreshSession();
									if (outcome === "refreshed" || outcome === "not-needed")
										return;
									throw new Error(
										outcome === "invalidated"
											? "Stored session is invalidated."
											: `Stored session could not be refreshed (${outcome}). Run \`tedix login\` to re-authenticate, then resume the existing run.`,
									);
								}
								const challenge = extractWWWAuthenticateParams(response);
								const authOptions = { serverUrl, fetchFn, ...challenge };
								if (!provider.authorizeInteractive)
									throw new Error("OAuth interactive handler is unavailable");
								await provider.authorizeInteractive(authOptions);
							}, true);
						},
					},
					fetch: async (url, init) => {
						init?.signal?.throwIfAborted();
						let scope: NativeCallScope | undefined;
						if (typeof init?.body === "string") {
							try {
								scope = this.#nativeScopes.get(
									String(JSON.parse(init.body).id),
								);
							} catch {}
						}
						if (!scope && init?.method === "GET") {
							const token = new Headers(init.headers).get("last-event-id");
							const candidates = token
								? this.#nativeResumptions.get(token)
								: undefined;
							if (token && !candidates)
								throw new Error("Unknown native SSE resumption identity");
							if (candidates && candidates.size !== 1) {
								const error = new Error(
									"Ambiguous native SSE resumption identity",
								);
								for (const owner of candidates.values()) owner?.abort(error);
								throw error;
							}
							scope = candidates?.values().next().value;
						}
						if (!scope) return this.#fetch(url, init);
						return scope.receive(
							this.#fetch(url, { ...init, signal: scope.signal }),
						);
					},
					onInsufficientScope: "throw",
				})
			: undefined;
		if (this.#transport) {
			this.#transport.onmessage = (message: JSONRPCMessage) => {
				if (!("id" in message) || message.id === undefined) return;
				const pending = this.#pendingTransport.get(String(message.id));
				if (!pending) return;
				this.#pendingTransport.delete(String(message.id));
				pending.resolve(
					"error" in message
						? { error: message.error }
						: { result: "result" in message ? message.result : undefined },
				);
			};
		}
		this.#connectFn = options.connect;
	}

	#runOAuthTransaction(
		operation: () => Promise<void>,
		join = false,
	): Promise<void> {
		if (join && this.#oauthFlow) return this.#oauthFlow;
		const flow = (this.#oauthFlow ?? Promise.resolve()).then(operation);
		const pending = flow.finally(() => {
			if (this.#oauthFlow === pending) this.#oauthFlow = undefined;
		});
		this.#oauthFlow = pending;
		return pending;
	}

	#client: McpClientLike | undefined;
	#connecting: Promise<McpClientLike> | undefined;
	// Bumped on every fresh connection. Lets a reconnect-once retry tell whether
	// a sibling concurrent call already reconnected (so it must not reset again).
	#generation = 0;
	// A gateway 429 applies to every read on this shared client, not only the
	// call that observed it. Hold subsequent read/list calls until retryAfter so
	// the run/event/panel pollers do not amplify one rejection into a retry storm.
	#readCooldownUntil = 0;
	#readCooldownWaiters = new Set<() => void>();

	async #waitForReadCooldown(signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		const delayMs = this.#readCooldownUntil - Date.now();
		if (delayMs <= 0) return;
		await new Promise<void>((resolve) => {
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.#readCooldownWaiters.delete(finish);
				signal?.removeEventListener("abort", finish);
				resolve();
			};
			const timer = setTimeout(finish, delayMs);
			timer.unref?.();
			this.#readCooldownWaiters.add(finish);
			signal?.addEventListener("abort", finish, { once: true });
		});
		signal?.throwIfAborted();
	}

	#recordRateLimit(error: unknown): void {
		const retryMs = rateLimitRetryAfterMs(error);
		if (retryMs === null) return;
		this.#readCooldownUntil = Math.max(
			this.#readCooldownUntil,
			Date.now() + retryMs,
		);
	}

	#releaseNativeResumption(requestId: string): void {
		const token = this.#nativeResumptionTokens.get(requestId);
		if (token === undefined) return;
		this.#nativeResumptionTokens.delete(requestId);
		const owners = this.#nativeResumptions.get(token);
		owners?.delete(requestId);
		if (owners?.size === 0) this.#nativeResumptions.delete(token);
	}
	#registerNativeResumption(
		requestId: string,
		token: string,
		scope?: NativeCallScope,
	): void {
		// Keep only the latest SDK-issued token for each request. No live owner
		// is evicted when the finite connection registration limit is reached.
		if (
			!this.#nativeResumptionTokens.has(requestId) &&
			this.#nativeResumptionTokens.size >= 64
		) {
			const error = new Error("Native SSE active resumption limit exceeded");
			scope?.abort(error);
			throw error;
		}
		this.#releaseNativeResumption(requestId);
		const owners =
			this.#nativeResumptions.get(token) ??
			new Map<string, NativeCallScope | undefined>();
		owners.set(requestId, scope);
		this.#nativeResumptions.set(token, owners);
		this.#nativeResumptionTokens.set(requestId, token);
	}

	async #rawModernRequest(
		method: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		scope?: NativeCallScope,
		extraHeaders: Record<string, string> = {},
	): Promise<unknown> {
		scope?.guard();
		const target = mcpRequestTargetName(method, params);
		if (MCP_NAME_REQUIRED_METHODS.has(method) && !target) {
			throw new Error(`${method} requires a request target`);
		}
		const trace = createCliRequestTrace(this.#options.headers, params._meta);
		const request = {
			jsonrpc: "2.0" as const,
			id: crypto.randomUUID(),
			method,
			params: {
				...params,
				_meta: {
					...trace.meta,
					[MCP_PROTOCOL_VERSION_META_KEY]: MCP_MODERN_PROTOCOL_VERSION,
					[MCP_CLIENT_INFO_META_KEY]: CLI_CLIENT_INFO,
					[MCP_CLIENT_CAPABILITIES_META_KEY]: CLI_CLIENT_CAPABILITIES,
				},
			},
		};
		const requestHeaders = {
			...extraHeaders,
			...trace.headers,
			[MCP_METHOD_HEADER]: method,
			...(target ? { [MCP_NAME_HEADER]: target } : {}),
			[MCP_PROTOCOL_VERSION_HEADER]: MCP_MODERN_PROTOCOL_VERSION,
		};
		try {
			if (this.#transport) {
				if (scope) this.#nativeScopes.set(String(request.id), scope);
				try {
					return await this.#sendTransportRequest(
						request,
						requestHeaders,
						signal,
						true,
						scope,
					);
				} finally {
					this.#nativeScopes.delete(String(request.id));
					this.#releaseNativeResumption(String(request.id));
				}
			}
			const fetching = this.#fetch(this.#options.url, {
				method: "POST",
				headers: {
					...requestHeaders,
					"Accept-Encoding": "identity",
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
				},
				body: JSON.stringify(request),
				signal,
			});
			const response = scope ? await scope.receive(fetching) : await fetching;
			const reading = response.text();
			const text = scope ? await scope.wait(reading) : await reading;
			let payload: { error?: unknown; result?: unknown };
			try {
				payload = parseMcpResponsePayload(text, method);
			} catch (error) {
				if (!response.ok) {
					throw new Error(
						`MCP ${method} failed (${response.status}): ${text.slice(0, 500)}`,
						{ cause: error },
					);
				}
				throw error;
			}
			if (payload.error !== undefined) {
				throw new Error(
					`MCP ${method} error: ${JSON.stringify(payload.error)}`,
				);
			}
			if (!response.ok) {
				throw new Error(
					`MCP ${method} failed (${response.status}): ${text.slice(0, 500)}`,
				);
			}
			return payload.result;
		} catch (error) {
			// Preserve auth/retry classification. Add only the validated trace identifier,
			// never request headers, URLs, credentials, or tool arguments.
			if (error instanceof Error) {
				const message = `${error.message} [traceId: ${trace.traceId}]`;
				// Clone rather than mutate shared or immutable provider errors. Preserve
				// their prototype and fields for existing retry, auth and abort classification.
				const receipt =
					error instanceof DOMException
						? new DOMException(message, error.name)
						: new Error(message);
				if (!(error instanceof DOMException))
					Object.setPrototypeOf(receipt, Object.getPrototypeOf(error));
				for (const key of Reflect.ownKeys(error)) {
					if (key === "message" || key === "stack") continue;
					const descriptor = Object.getOwnPropertyDescriptor(error, key);
					if (descriptor) Object.defineProperty(receipt, key, descriptor);
				}
				if (!("cause" in receipt))
					Object.defineProperty(receipt, "cause", { value: error });
				throw receipt;
			}
			throw new Error(
				`MCP ${method} request failed [traceId: ${trace.traceId}]`,
				{ cause: error },
			);
		}
	}

	async #sendTransportRequest(
		request: JSONRPCMessage,
		headers: Record<string, string>,
		signal?: AbortSignal,
		allowAuthRetry = true,
		scope?: NativeCallScope,
	): Promise<unknown> {
		const transport = this.#transport;
		if (!transport || !("id" in request) || request.id === undefined) {
			throw new Error("SDK MCP transport is not available");
		}
		this.#transportStarted ??= transport.start();
		if (scope) await scope.wait(this.#transportStarted);
		else await this.#transportStarted;
		const key = String(request.id);
		signal?.throwIfAborted();
		let onAbort = () => {};
		const response = new Promise<{ error?: unknown; result?: unknown }>(
			(resolve) => {
				this.#pendingTransport.set(key, { resolve });
				onAbort = () =>
					resolve({
						error: signal?.reason ?? new DOMException("Aborted", "AbortError"),
					});
				signal?.addEventListener("abort", onAbort, { once: true });
			},
		);
		try {
			try {
				const sending = transport.send(request, {
					headers,
					...(signal ? { requestSignal: signal } : {}),
					onresumptiontoken: (token: string) => {
						signal?.throwIfAborted();
						scope?.guard();
						this.#registerNativeResumption(String(request.id), token, scope);
					},
				});
				if (scope) await scope.wait(sending);
				else await sending;
			} catch (error) {
				this.#pendingTransport.delete(key);
				if (
					!scope &&
					allowAuthRetry &&
					error instanceof InsufficientScopeError &&
					error.requiredScope &&
					this.#oauthProvider?.authorizeScopeChallenge
				) {
					const provider = this.#oauthProvider;
					const scope = error.requiredScope;
					await this.#runOAuthTransaction(() =>
						provider.authorizeScopeChallenge!(scope),
					);
					return this.#sendTransportRequest(request, headers, signal, false);
				}
				throw error;
			}
			const payload = scope ? await scope.wait(response) : await response;
			if (payload.error instanceof Error) throw payload.error;
			if (payload.error !== undefined) {
				throw new Error(`MCP request error: ${JSON.stringify(payload.error)}`);
			}
			return payload.result;
		} finally {
			signal?.removeEventListener("abort", onAbort);
			this.#pendingTransport.delete(key);
		}
	}

	async #ensureModernProtocol(
		signal?: AbortSignal,
		scope?: NativeCallScope,
		sequence?: object,
	): Promise<{ supportsTasks: boolean }> {
		const discover = async () => {
			const cached = this.#discoveryCache?.read(this.#options.url);
			if (cached) {
				this.#discoveryFromCache = true;
				return cached;
			}
			const result = await this.#rawModernRequest(
				"server/discover",
				{},
				signal,
				scope,
			);
			const versions = isRecord(result) ? result.supportedVersions : undefined;
			if (
				!Array.isArray(versions) ||
				!versions.includes(MCP_MODERN_PROTOCOL_VERSION)
			) {
				throw new Error(
					`MCP gateway does not advertise required protocol ${MCP_MODERN_PROTOCOL_VERSION}`,
				);
			}
			const capabilities = isRecord(result) ? result.capabilities : undefined;
			const extensions = isRecord(capabilities)
				? capabilities.extensions
				: undefined;
			const protocol = {
				supportsTasks:
					isRecord(extensions) && MCP_TASKS_EXTENSION in extensions,
			};
			this.#discoveryCache?.write(this.#options.url, protocol);
			return protocol;
		};
		if (scope) {
			scope.guard();
			const completed = sequence && this.#nativeProtocols.get(sequence);
			if (completed) return completed;
			// Never share a pending discovery tied to another caller's signal or budget.
			const protocol = await discover();
			scope.guard();
			if (sequence) this.#nativeProtocols.set(sequence, protocol);
			return protocol;
		}
		this.#modernDiscovery ??= discover();
		try {
			return await this.#modernDiscovery;
		} catch (error) {
			this.#modernDiscovery = undefined;
			throw error;
		}
	}

	async #rawModernToolCall(
		toolName: string,
		args: Record<string, unknown>,
		options: McpCallOptions,
		scope?: NativeCallScope,
	): Promise<unknown> {
		const protocol = await this.#ensureModernProtocol(
			options.signal,
			scope,
			options.protocolSequence,
		);
		try {
			return await this.#modernToolCallRounds(
				toolName,
				args,
				options,
				protocol,
				scope,
			);
		} catch (error) {
			// A reused discovery answer may be stale: rediscover on the next command.
			if (this.#discoveryFromCache && isStaleDiscoveryError(error))
				this.#discoveryCache?.forget(this.#options.url);
			throw error;
		}
	}

	async #modernToolCallRounds(
		toolName: string,
		args: Record<string, unknown>,
		options: McpCallOptions,
		protocol: { supportsTasks: boolean },
		scope?: NativeCallScope,
	): Promise<unknown> {
		let params: Record<string, unknown> = {
			name: toolName,
			arguments: args,
		};
		let result: unknown;
		for (let round = 0; round <= MAX_SYNC_INPUT_ROUNDS; round++) {
			result = await this.#rawModernRequest(
				"tools/call",
				params,
				options.signal,
				scope,
			);
			if (!isRecord(result) || result.resultType !== "input_required") {
				if (
					isRecord(result) &&
					result.resultType === "task" &&
					!protocol.supportsTasks
				) {
					throw new Error(
						`MCP gateway returned a Task without advertising ${MCP_TASKS_EXTENSION}`,
					);
				}
				return result;
			}
			const inputRequests = isRecord(result.inputRequests)
				? result.inputRequests
				: {};
			const inputResponses = resolveCliTaskInputResponses(
				options.destructiveApprovalReason,
				inputRequests,
			);
			if (!inputResponses || round === MAX_SYNC_INPUT_ROUNDS) return result;
			params = {
				...params,
				inputResponses,
				...(result.requestState !== undefined
					? { requestState: result.requestState }
					: {}),
			};
		}
		return result;
	}

	async #getClient(): Promise<McpClientLike> {
		if (this.#client) return this.#client;
		if (!this.#connectFn) {
			throw new Error("No injected MCP client is configured");
		}
		if (!this.#connecting) {
			const connect = this.#connectFn;
			this.#connecting = (async () => {
				const client = await connect();
				// Assign client + bump generation together (no await between) so
				// #generation always identifies the current #client.
				this.#client = client;
				this.#generation++;
				return client;
			})();
		}
		try {
			return await this.#connecting;
		} finally {
			this.#connecting = undefined;
		}
	}

	async #resetClient(): Promise<void> {
		const client = this.#client;
		this.#client = undefined;
		if (client) await client.close().catch(() => {});
	}

	/** Tear down the shared MCP connection. Safe to call multiple times. */
	async close(): Promise<void> {
		// Ctrl-D/session teardown must not wait out a server-supplied 60s cooldown.
		this.#readCooldownUntil = 0;
		for (const release of [...this.#readCooldownWaiters]) release();
		await this.#transport?.close().catch(() => {});
		await this.#resetClient();
	}

	async #rawCall(
		toolName: string,
		args: Record<string, unknown>,
		options: McpCallOptions = {},
		scope?: NativeCallScope,
	): Promise<unknown> {
		const retryable =
			options.retryable ??
			(toolName.includes("read_") || toolName.includes("list_"));
		options.signal?.throwIfAborted();
		if (retryable) await this.#waitForReadCooldown(options.signal);
		if (!this.#connectFn) {
			try {
				return await this.#rawModernToolCall(toolName, args, options, scope);
			} catch (error) {
				if (isRateLimitError(error)) {
					this.#recordRateLimit(error);
					throw error;
				}
				if (options.signal?.aborted || !retryable || !isConnectionError(error))
					throw error;
				return this.#rawModernToolCall(toolName, args, options, scope);
			}
		}
		const call = (client: McpClientLike): Promise<unknown> =>
			client.callTool(
				{ name: toolName, arguments: args },
				{
					resetTimeoutOnProgress: !scope,
					...(options.signal ? { signal: options.signal } : {}),
					timeout: scope
						? Math.max(1, scope.deadlineAt - Date.now())
						: this.#options.timeoutMs,
				},
			);
		const connecting = this.#getClient();
		const client = scope ? await scope.wait(connecting) : await connecting;
		const generation = this.#generation;
		try {
			const calling = call(client);
			const result = scope ? await scope.wait(calling) : await calling;
			if (scope)
				scope.charge(
					new TextEncoder().encode(JSON.stringify(result)).byteLength,
				);
			return result;
		} catch (error) {
			if (isRateLimitError(error)) {
				this.#recordRateLimit(error);
				throw error;
			}
			// Only self-heal a dropped shared connection, and only for idempotent
			// reads. A non-connection error (JSON-RPC -32603, validation, auth)
			// propagates without touching the shared client.
			if (options.signal?.aborted || !retryable || !isConnectionError(error))
				throw error;
			// Reset once — but skip if a sibling concurrent read already
			// reconnected (its bump changed #generation), so concurrent reads
			// never close each other's freshly-reconnected client.
			if (this.#generation === generation) await this.#resetClient();
			return await call(await this.#getClient());
		}
	}

	async #resolveTaskResult(
		result: unknown,
		options: McpCallOptions,
		scope?: NativeCallScope,
	): Promise<unknown> {
		if (!isRecord(result) || result.resultType !== "task") return result;
		const created = McpCreateTaskResultSchema.safeParse(result);
		if (!created.success) {
			throw new McpTaskResponseError("tools/call", created.error.issues);
		}
		const outcome = await pollMcpTask({
			taskId: created.data.taskId,
			request: async (method, params, signal) => {
				if (scope && method === "tasks/cancel" && signal === undefined) {
					// Courtesy cancellation shares the original byte quota and absolute
					// deadline; it cannot create another operation window after expiry.
					const cleanup = scope.cancellationScope();
					if (!cleanup)
						throw (
							scope.signal.reason ??
							new Error("Native cancellation deadline elapsed")
						);
					try {
						return await this.#rawModernRequest(
							method,
							params,
							cleanup.signal,
							cleanup,
						);
					} finally {
						cleanup.close();
					}
				}
				return this.#rawModernRequest(method, params, signal, scope);
			},
			signal: options.signal,
			strict: true,
			timeoutMs: scope
				? Math.max(1, scope.deadlineAt - Date.now())
				: this.#options.timeoutMs,
			resolveInput: ({ inputRequests }) =>
				resolveCliTaskInputResponses(
					options.destructiveApprovalReason,
					inputRequests,
				),
			// Ctrl-C already reports the abort; a failed courtesy cancel is noise.
			onCancelError: () => {},
		});
		switch (outcome.status) {
			case "completed":
				return outcome.result;
			case "input_required":
				// Convert the Task extension's pending-input state back to the
				// canonical tools/call outcome. The shared result normalizer then
				// fails closed instead of presenting an unexecuted task as success.
				return {
					resultType: "input_required",
					inputRequests: outcome.inputRequests,
				};
			case "timeout":
				return outcome.state ?? result;
			default:
				return outcome.state;
		}
	}

	getTimeoutMs(): number {
		return this.#options.timeoutMs;
	}

	async callTool<T = unknown>(
		toolName: string,
		args: Record<string, unknown>,
		options: McpCallOptions = {},
	): Promise<T> {
		if (options.maxResponseBytes === undefined)
			return this.#callToolScoped<T>(toolName, args, options);
		const frozenArgs = structuredClone(args);
		const frozenOptions = { ...options };
		const scope = new NativeCallScope(frozenOptions, this.#options.timeoutMs);
		try {
			return await this.#callToolScoped<T>(
				toolName,
				frozenArgs,
				{ ...frozenOptions, signal: scope.signal },
				scope,
			);
		} finally {
			scope.close();
		}
	}

	async callToolWithDestructiveApproval<T = unknown>(
		toolName: string,
		args: Record<string, unknown>,
		reason: string,
		options: McpCallOptions,
	): Promise<T> {
		const frozenArgs = structuredClone(args),
			frozenOptions = { ...options };
		const deadlineAt = Math.min(
			Date.now() + (options.timeoutMs ?? this.#options.timeoutMs),
			options.deadlineAt ?? Infinity,
		);
		const queueScope = new NativeCallScope(
			{ ...frozenOptions, deadlineAt },
			this.#options.timeoutMs,
		);
		try {
			return await this.#withDestructiveApproval(
				reason,
				() =>
					this.callTool<T>(toolName, frozenArgs, {
						...frozenOptions,
						deadlineAt,
						destructiveApprovalReason: reason,
						retryable: false,
					}),
				queueScope,
			);
		} finally {
			queueScope.close();
		}
	}

	async #callToolScoped<T = unknown>(
		toolName: string,
		args: Record<string, unknown>,
		options: McpCallOptions,
		scope?: NativeCallScope,
	): Promise<T> {
		// A tool error that says the gateway refused before dispatch is resent;
		// no other tool-level error is.
		return resendPreDispatchToolRefusals(
			() => this.#callToolAttempt<T>(toolName, args, options, scope),
			{
				signal: options.signal,
				deadlineAt: scope?.deadlineAt ?? options.deadlineAt,
			},
		);
	}

	async #callToolAttempt<T = unknown>(
		toolName: string,
		args: Record<string, unknown>,
		options: McpCallOptions,
		scope?: NativeCallScope,
	): Promise<T> {
		// unwrap runs outside the connection retry so a tool-level isError is
		// never retried there.
		try {
			scope?.guard();
			const result = await this.#rawCall(toolName, args, options, scope);
			const resolving = this.#resolveTaskResult(result, options, scope);
			const resolved = scope ? await scope.wait(resolving) : await resolving;
			scope?.guard();
			return unwrapToolResult(resolved, toolName) as T;
		} catch (error) {
			// An access token that expires mid-call is rejected by the API as an
			// oRPC UNAUTHORIZED inside an otherwise successful tool call, NOT as a
			// transport 401 — so the SDK's own refresh-on-401 never sees it. The
			// proactive renewal in resolveStoredLoginAuth covers the common case;
			// this covers a call that outlives its token, which the pre-flight skew
			// cannot. Exactly one retry, and only after a renewal actually
			// succeeded, so a genuinely unauthorized caller still fails fast.
			if (!options.retriedAfterSessionRefresh && isExpiredSessionError(error)) {
				const renewing = this.#oauthProvider?.refreshSession?.();
				const outcome =
					scope && renewing ? await scope.wait(renewing) : await renewing;
				if (outcome === "refreshed" || outcome === "not-needed") {
					return this.#callToolAttempt<T>(
						toolName,
						args,
						{
							...options,
							retriedAfterSessionRefresh: true,
						},
						scope,
					);
				}
			}
			// Some MCP edges express the 429 as a tool-level isError result rather
			// than a transport rejection. Record the same shared read cooldown.
			this.#recordRateLimit(error);
			throw error;
		}
	}

	async getTask(taskId: string, signal?: AbortSignal): Promise<McpTaskState> {
		const protocol = await this.#ensureModernProtocol(signal);
		if (!protocol.supportsTasks) {
			throw new Error(
				`MCP gateway does not advertise required extension ${MCP_TASKS_EXTENSION}`,
			);
		}
		const result = await this.#rawModernRequest(
			"tasks/get",
			{ taskId },
			signal,
		);
		return parseMcpTaskState(result, { strict: true });
	}

	async discoverProtocol(signal?: AbortSignal): Promise<unknown> {
		return this.#rawModernRequest("server/discover", {}, signal);
	}

	/**
	 * Send one JSON-RPC request, by method name, to the selected gateway and
	 * return its result. Authentication comes from this client's stored login;
	 * the caller never sees a credential.
	 */
	async rawRequest(
		method: string,
		params: Record<string, unknown> = {},
		options: { headers?: Record<string, string>; signal?: AbortSignal } = {},
	): Promise<unknown> {
		if (method !== "server/discover") {
			await this.#ensureModernProtocol(options.signal);
		}
		return this.#rawModernRequest(
			method,
			params,
			options.signal,
			undefined,
			options.headers,
		);
	}

	async readResource(uri: string, signal?: AbortSignal): Promise<unknown> {
		await this.#ensureModernProtocol(signal);
		return this.#rawModernRequest("resources/read", { uri }, signal);
	}

	async listResources(cursor?: string, signal?: AbortSignal): Promise<unknown> {
		await this.#ensureModernProtocol(signal);
		return this.#rawModernRequest(
			"resources/list",
			cursor ? { cursor } : {},
			signal,
		);
	}

	async updateTask(
		taskId: string,
		inputResponses: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<void> {
		const protocol = await this.#ensureModernProtocol(signal);
		if (!protocol.supportsTasks) {
			throw new Error(
				`MCP gateway does not advertise required extension ${MCP_TASKS_EXTENSION}`,
			);
		}
		const result = await this.#rawModernRequest(
			"tasks/update",
			{ taskId, inputResponses },
			signal,
		);
		assertMcpTaskAck("tasks/update", result, { strict: true });
	}

	async cancelTask(taskId: string): Promise<void> {
		const protocol = await this.#ensureModernProtocol();
		if (!protocol.supportsTasks) {
			throw new Error(
				`MCP gateway does not advertise required extension ${MCP_TASKS_EXTENSION}`,
			);
		}
		const result = await this.#rawModernRequest("tasks/cancel", { taskId });
		assertMcpTaskAck("tasks/cancel", result, { strict: true });
	}

	async askHome(
		input: AskHomeInput,
		options: McpCallOptions = {},
	): Promise<unknown> {
		const result = await this.#rawCall(
			"ask",
			{
				content: input.content,
				conversationId: input.conversationId,
				...(input.delegateToTediId
					? { delegateToTediId: input.delegateToTediId }
					: {}),
				...(input.verifyCommand ? { verifyCommand: input.verifyCommand } : {}),
				...(input.metadata ? { metadata: input.metadata } : {}),
			},
			options,
		);
		if (isRecord(result) && result.resultType === "task") {
			const task = McpCreateTaskResultSchema.safeParse(result);
			if (!task.success) {
				throw new McpTaskResponseError("tools/call ask", task.error.issues);
			}
			// A native Task response is already the durable acknowledgement. Do not
			// hide it behind a second Code Mode read: that recreates the blocking
			// request the Tasks extension is designed to avoid and can lose the only
			// authoritative run id when the follow-up request times out.
			// The create acknowledgement can race Home's persist-first run envelope:
			// that row may already say `completed` before the asynchronous turn body
			// has stored its answer. Always enter the tasks/get poll path once so the
			// task handler's durable completion fence owns terminality.
			return homePayloadFromTask({ ...task.data, status: "working" });
		}
		return unwrapToolResult(result, "ask");
	}

	async #callHomeTool(
		toolName: string,
		args: Record<string, unknown>,
		options: McpCallOptions = {},
	): Promise<unknown> {
		if (!/^[a-z][a-z0-9_]*$/.test(toolName)) {
			throw new Error(`Invalid Home tool name: ${toolName}`);
		}
		return this.callTool(
			"code",
			{
				code: `async () => await home.${toolName}(${JSON.stringify(args)})`,
			},
			options,
		);
	}

	async readHomeRun(homeRunId: string, signal?: AbortSignal): Promise<unknown> {
		return this.#callHomeTool(
			"read_home_run",
			{ runId: homeRunId },
			{ retryable: true, signal },
		);
	}

	/**
	 * Read Home transcript messages, projected to the fields the CLI renders.
	 *
	 * A raw `read_home_messages` row carries its whole `runtime.metadata` — the
	 * delegation work order, execution requirement, usage — so even TWO rows
	 * exceed the Code Mode gateway's result budget and come back as a truncation
	 * preview with no messages in it. Project inside the gateway program so the
	 * result is small by construction, and halve the page when it still does not
	 * fit (one message with a very long answer can be over budget on its own).
	 */
	async readHomeMessages(input: ReadHomeMessagesInput): Promise<unknown> {
		let limit = Math.max(1, input.limit ?? HOME_MESSAGES_PAGE);
		while (true) {
			const args = {
				conversationId: input.conversationId,
				...(input.cursor ? { cursor: input.cursor } : {}),
				limit,
			};
			const payload = await this.callTool(
				"code",
				{
					code: `async () => {
	const page = await home.read_home_messages(${JSON.stringify(args)});
	const rows = Array.isArray(page && page.messages) ? page.messages : [];
	return {
		messages: rows.map((m) => ({
			id: m.id,
			role: m.role,
			content: typeof m.content === "string" ? m.content : "",
			runId: m.runId ?? undefined,
			createdAt: m.createdAt ?? undefined,
		})),
		nextCursor: (page && page.nextCursor) ?? undefined,
	};
}`,
				},
				{ retryable: true },
			);
			const normalized = normalizeCodeResult(payload);
			if (!normalized.truncated) return normalized.value;
			if (limit <= 1) {
				throw new Error(
					`Home message page is too large for the Code Mode gateway to return${
						normalized.truncationHint ? `: ${normalized.truncationHint}` : "."
					}`,
				);
			}
			limit = Math.max(1, Math.floor(limit / 2));
		}
	}

	/**
	 * Read the conversation's run set, projected to the fields the CLI renders.
	 *
	 * A raw run row carries its whole `runtime.metadata` (execution requirement,
	 * redrive input, work orders) so a page of twenty real runs is several times
	 * the Code Mode gateway's result budget and comes back as a truncation
	 * preview with no runs in it. `tedix status` used to read that preview as an
	 * empty conversation. Project inside the gateway program so the result is
	 * small by construction, halve the page while it still does not fit, and
	 * return the unwrapped `{ runSet }` payload rather than the gateway envelope.
	 */
	async readHomeRunSet(input: ReadHomeRunSetInput): Promise<unknown> {
		let limit = Math.max(1, input.limit ?? HOME_RUN_SET_PAGE);
		while (true) {
			const args = { conversationId: input.conversationId, limit };
			const payload = await this.callTool(
				"code",
				{
					code: `async () => {
	const clip = (value, max) =>
		typeof value === "string" && value.length > max
			? value.slice(0, max) + "…"
			: value;
	const pick = (source, keys) => {
		const out = {};
		if (!source || typeof source !== "object") return out;
		for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
		return out;
	};
	const projectRun = (run) => {
		const metadata = run.metadata && typeof run.metadata === "object" ? run.metadata : {};
		const route = metadata.kernelRoute && typeof metadata.kernelRoute === "object" ? metadata.kernelRoute : undefined;
		const body = metadata.bodyExecutionResult && typeof metadata.bodyExecutionResult === "object" ? metadata.bodyExecutionResult : undefined;
		return {
			...pick(run, ${JSON.stringify(HOME_RUN_SET_RUN_KEYS)}),
			metadata: {
				...pick(metadata, ${JSON.stringify(HOME_RUN_SET_METADATA_KEYS)}),
				...(route ? { kernelRoute: { ...route, answer: clip(route.answer, 2000) } } : {}),
				...(body ? { bodyExecutionResult: { summary: clip(body.summary, 2000) } } : {}),
				...(metadata.childRunPreview !== undefined ? { childRunPreview: clip(metadata.childRunPreview, 500) } : {}),
			},
		};
	};
	const payload = await home.read_home_run_set(${JSON.stringify(args)});
	const runSet = payload && typeof payload === "object" && payload.runSet && typeof payload.runSet === "object" ? payload.runSet : payload;
	if (!runSet || typeof runSet !== "object") return payload;
	return {
		runSet: {
			...pick(runSet, ["organizationId", "conversationId", "activeRunIds", "approvalMirrors", "updatedAt"]),
			runs: (Array.isArray(runSet.runs) ? runSet.runs : []).map(projectRun),
		},
	};
}`,
				},
				{ retryable: true },
			);
			const normalized = normalizeCodeResult(payload);
			if (!normalized.truncated) return normalized.value;
			if (limit <= 1) {
				throw new Error(
					`Home run set is too large for the Code Mode gateway to return${
						normalized.truncationHint ? `: ${normalized.truncationHint}` : "."
					}`,
				);
			}
			limit = Math.max(1, Math.floor(limit / 2));
		}
	}

	async readHomeConversationTitle(
		conversationId: string,
	): Promise<string | undefined> {
		let cursor: string | undefined;
		do {
			const args = {
				limit: 100,
				includeArchived: true,
				...(cursor ? { cursor } : {}),
			};
			const payload = await this.callTool(
				"code",
				{
					code: `async () => {
const page = await home.list_conversations(${JSON.stringify(args)});
const conversation = page.conversations.find(row => row.id === ${JSON.stringify(conversationId)});
return { found: Boolean(conversation), title: conversation?.title ?? null, nextCursor: page.nextCursor ?? null };
}`,
				},
				{ retryable: true },
			);
			const normalized = normalizeCodeResult(payload);
			if (normalized.truncated || !isRecord(normalized.value))
				throw new Error(
					"Home conversation title read was truncated or invalid",
				);
			const page = normalized.value;
			if (page.found)
				return typeof page.title === "string" ? page.title : undefined;
			cursor =
				typeof page.nextCursor === "string" ? page.nextCursor : undefined;
		} while (cursor);
		return undefined;
	}

	async listHomeConversations(
		input: ListHomeConversationsInput,
	): Promise<unknown> {
		return this.#callHomeTool(
			"list_conversations",
			{
				...(input.channel ? { channel: input.channel } : {}),
				...(input.cursor ? { cursor: input.cursor } : {}),
				...(input.includeArchived ? { includeArchived: true } : {}),
				...(input.limit ? { limit: input.limit } : {}),
				...(input.search ? { search: input.search } : {}),
			},
			{ retryable: true },
		);
	}

	async renameConversation(input: {
		conversationId: string;
		title: string;
	}): Promise<unknown> {
		return this.#callHomeTool("rename_conversation", {
			conversationId: input.conversationId,
			title: input.title,
		});
	}

	async pinConversation(input: {
		conversationId: string;
		pinned: boolean;
	}): Promise<unknown> {
		return this.#callHomeTool("pin_conversation", {
			conversationId: input.conversationId,
			pinned: input.pinned,
		});
	}

	async deleteConversation(input: {
		conversationId: string;
	}): Promise<unknown> {
		return this.#callHomeTool("delete_conversation", {
			conversationId: input.conversationId,
			confirmDestructive: true,
			reason: `CLI delete command for ${input.conversationId}`,
		});
	}

	async readDelegatedTediTraces(input: {
		tediId: string;
		runId?: string;
		limit?: number;
	}): Promise<unknown> {
		return this.#callHomeTool(
			"read_delegated_tedi_traces",
			{
				tediId: input.tediId,
				...(input.runId ? { runId: input.runId } : {}),
				...(input.limit ? { limit: input.limit } : {}),
			},
			{ retryable: true },
		);
	}

	async listKernelTraceBundles(
		input: ListKernelTraceBundlesInput,
	): Promise<unknown> {
		return this.#callHomeTool(
			"list_kernel_trace_bundles",
			{
				...(input.harnessVersionId
					? { harnessVersionId: input.harnessVersionId }
					: {}),
				...(input.limit ? { limit: input.limit } : {}),
				...(input.runId ? { runId: input.runId } : {}),
			},
			{ retryable: true },
		);
	}

	async readHomeTrace(homeRunId: string): Promise<unknown> {
		return this.#callHomeTool(
			"read_home_trace",
			{ runId: homeRunId },
			{ retryable: true },
		);
	}

	/**
	 * Run a Code Mode snippet on the gateway's single `code` tool. `source` is a
	 * JS async function (e.g. `async () => await discover.search({ query })`)
	 * executed in the gateway's V8 sandbox against the org's namespaced tool
	 * providers. Returns the unwrapped result, or throws if the code errored.
	 */
	async runCode(source: string): Promise<unknown> {
		return this.callTool("code", { code: source });
	}

	/**
	 * Run one Code Mode snippet that is expected to invoke a destructive tool.
	 *
	 * The explicit reason exists only for this serialized call, so the MCP
	 * connection's elicitation handler cannot accidentally approve an unrelated
	 * concurrent request.
	 */
	async runCodeWithDestructiveApproval(
		source: string,
		reason: string,
	): Promise<unknown> {
		return this.#withDestructiveApproval(reason, () =>
			this.callTool(
				"code",
				{ code: source },
				{ destructiveApprovalReason: reason },
			),
		);
	}

	async readChildRunEvidence(
		input: ReadChildRunEvidenceInput,
	): Promise<unknown> {
		return this.#callHomeTool(
			"read_child_run_evidence",
			{
				childRunId: input.childRunId,
				delegatedTediId: input.delegatedTediId,
				...(input.artifactLimit ? { artifactLimit: input.artifactLimit } : {}),
				...(input.limit ? { limit: input.limit } : {}),
			},
			{ retryable: true },
		);
	}

	/**
	 * Read the conversation's delegated child-run tree, projected to the node
	 * fields the CLI renders (a child's preview is the delegated tedi's whole
	 * answer, so unprojected nodes overrun the gateway budget together). Returns
	 * the unwrapped `{ tree }` payload rather than the gateway envelope, halving
	 * the page while the gateway still truncates it.
	 */
	async readChildRunTree(input: ReadChildRunTreeInput): Promise<unknown> {
		let limit = input.limit ? Math.max(1, input.limit) : undefined;
		while (true) {
			const args = {
				conversationId: input.conversationId,
				...(limit ? { limit } : {}),
			};
			const payload = await this.callTool(
				"code",
				{
					code: `async () => {
	const clip = (value, max) =>
		typeof value === "string" && value.length > max
			? value.slice(0, max) + "…"
			: value;
	const pick = (source, keys) => {
		const out = {};
		if (!source || typeof source !== "object") return out;
		for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
		return out;
	};
	const projectNode = (node) => {
		if (!node || typeof node !== "object") return node;
		const metadata = node.metadata && typeof node.metadata === "object" ? node.metadata : {};
		return {
			...pick(node, ${JSON.stringify(HOME_CHILD_TREE_NODE_KEYS)}),
			metadata: {
				...pick(metadata, ["progress"]),
				...(metadata.preview !== undefined ? { preview: clip(metadata.preview, 300) } : {}),
			},
			children: (Array.isArray(node.children) ? node.children : []).map(projectNode),
		};
	};
	const payload = await home.read_child_run_tree(${JSON.stringify(args)});
	const tree = payload && typeof payload === "object" && payload.tree && typeof payload.tree === "object" ? payload.tree : null;
	if (!tree) return payload;
	return {
		tree: {
			...pick(tree, ["organizationId", "conversationId", "activeNodeId", "updatedAt"]),
			nodes: (Array.isArray(tree.nodes) ? tree.nodes : []).map(projectNode),
		},
	};
}`,
				},
				{ retryable: true },
			);
			const normalized = normalizeCodeResult(payload);
			if (!normalized.truncated) return normalized.value;
			if (limit !== undefined && limit <= 1) {
				throw new Error(
					`Home child-run tree is too large for the Code Mode gateway to return${
						normalized.truncationHint ? `: ${normalized.truncationHint}` : "."
					}`,
				);
			}
			limit = Math.max(1, Math.floor((limit ?? HOME_RUN_SET_PAGE) / 2));
		}
	}

	async readHomeRunEvents(
		input: ReadHomeRunEventsInput,
		signal?: AbortSignal,
	): Promise<HomeRunEventsPage> {
		const offset = input.offset ?? HOME_RUN_EVENTS_START;
		const parsedOffset = Number.parseInt(offset, 10);
		const start =
			Number.isFinite(parsedOffset) && parsedOffset > 0 ? parsedOffset : 0;
		// Home events carry full payloads — a delegation work order or a final
		// report is kilobytes on its own — and the Code Mode gateway replaces any
		// result over its token budget with a preview string. An unpaged read of a
		// real run is therefore truncated by default, which is why this used to
		// return nothing at all. Ask for a bounded slice, and halve it whenever the
		// gateway still says the answer did not fit.
		let limit = Math.max(1, input.limit ?? HOME_RUN_EVENTS_PAGE);
		let lastHint: string | undefined;
		while (true) {
			const payload = await this.#callHomeTool(
				"read_home_run_events",
				{
					runId: input.homeRunId,
					offset: start,
					limit,
					...(typeof input.waitMs === "number" ? { waitMs: input.waitMs } : {}),
					...(input.childRunId ? { childRunId: input.childRunId } : {}),
					...(input.delegatedTediId
						? { delegatedTediId: input.delegatedTediId }
						: {}),
				},
				{ retryable: true, signal },
			);
			// `#callHomeTool` runs the read as Code Mode, so `payload` is the gateway
			// envelope `{ executionId, result, logs }`; the page lives under `result`.
			const normalized = normalizeCodeResult(payload);
			if (!normalized.truncated) {
				return parseHomeRunEventsPage(normalized.value, offset);
			}
			lastHint = normalized.truncationHint;
			if (limit <= 1) {
				// One event that does not fit cannot be paged around. Fail loudly:
				// swallowing this is what turned `tedix tail` into silence.
				throw new Error(
					`Home run event at offset ${start} is too large for the Code Mode gateway to return${
						lastHint ? `: ${lastHint}` : "."
					}`,
				);
			}
			limit = Math.max(1, Math.floor(limit / 2));
		}
	}

	async respondHomeApproval(input: {
		homeRunId: string;
		decision: "approve" | "reject";
		note?: string;
	}): Promise<unknown> {
		return this.#callHomeTool("respond_home_approval", {
			runId: input.homeRunId,
			decision: input.decision,
			...(input.note ? { note: input.note } : {}),
		});
	}

	async retryDelegation(workItemId: string): Promise<unknown> {
		return this.#callHomeTool("retry_delegation", { workItemId });
	}

	async cancelHomeRun(input: {
		homeRunId: string;
		reason?: string;
	}): Promise<unknown> {
		const reason = input.reason?.trim();
		if (!reason) {
			throw new Error("A cancellation reason is required");
		}
		return this.#withDestructiveApproval(reason, () =>
			this.#callHomeTool(
				"cancel_home_run",
				{
					confirmDestructive: true,
					runId: input.homeRunId,
					reason,
				},
				{ destructiveApprovalReason: reason },
			),
		);
	}

	async #withDestructiveApproval<T>(
		reasonInput: string,
		call: () => Promise<T>,
		queueScope?: NativeCallScope,
	): Promise<T> {
		const reason = reasonInput.trim();
		if (!reason) throw new Error("A destructive approval reason is required");
		// The MCP SDK owns a single connection-level elicitation handler. Serialize
		// destructive calls so each server-initiated prompt observes only its own
		// explicit local reason, never another concurrent destructive call's reason.
		const previous = this.#destructiveCallTail;
		let release: (() => void) | undefined;
		this.#destructiveCallTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		try {
			if (queueScope) await queueScope.wait(previous);
			else await previous;
		} catch (error) {
			// A withdrawn queued call still preserves the predecessor fence for
			// the next caller; it never installs a reason or starts a tool call.
			void previous.finally(() => release?.());
			throw error;
		}
		this.#destructiveApprovalReason = reason;
		try {
			return await call();
		} finally {
			this.#destructiveApprovalReason = undefined;
			release?.();
		}
	}

	async steerHomeRun(input: {
		homeRunId: string;
		instruction: string;
	}): Promise<unknown> {
		return this.#callHomeTool("steer_home_run", {
			runId: input.homeRunId,
			instruction: input.instruction,
		});
	}
}
