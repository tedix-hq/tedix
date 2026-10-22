import {
	NativeCallScope,
	rawModernRequest,
	sendTransportRequest,
	modernToolCallRounds,
	registerNativeResumption,
} from "./home-client-native-scope";
import {
	callHomeTool,
	readHomeRun,
	readHomeMessages,
	readHomeRunSet,
	readHomeConversationTitle,
	listHomeConversations,
	readDelegatedTediTraces,
	listKernelTraceBundles,
	readHomeTrace,
	readChildRunEvidence,
	readChildRunTree,
	readHomeRunEvents,
} from "./home-client-code-reads";
import {
	homePayloadFromTask,
	type HomeRunEventsPage,
	isExpiredSessionError,
	unwrapToolResult,
} from "./home-payload";
import {
	resolveCliDestructiveElicitation,
	resolveCliTaskInputResponses,
} from "./home-elicitation";
import { isRateLimitError, rateLimitRetryAfterMs } from "./home-rate-limit";
import {
	extractWWWAuthenticateParams,
	type JSONRPCMessage,
	type OAuthClientProvider,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { McpCreateTaskResultSchema } from "@tedix/api-contract/schemas/mcp-tasks";
import {
	MCP_MODERN_PROTOCOL_VERSION,
	MCP_TASKS_EXTENSION,
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
import { isRecord } from "@tedix/api-contract/utils/is-record";
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
	/** Resolve current credentials before each request, including long-command polls. */
	credentialProvider?: () => Promise<Record<string, string>>;
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
		const fetcher = options.fetch ?? fetch;
		this.#fetch = retryRateLimitedPosts(
			options.credentialProvider
				? async (input, init) => {
						init?.signal?.throwIfAborted();
						const credentials = await options.credentialProvider!();
						init?.signal?.throwIfAborted();
						const headers = new Headers(init?.headers);
						headers.delete("Authorization");
						headers.delete("X-API-Key");
						for (const [name, value] of Object.entries(credentials))
							headers.set(name, value);
						return fetcher(input, { ...init, headers });
					}
				: fetcher,
		);
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
		return registerNativeResumption(
			this.#nativeResumptionTokens,
			this.#nativeResumptions,
			(requestId) => this.#releaseNativeResumption(requestId),
			requestId,
			token,
			scope,
		);
	}

	async #rawModernRequest(
		method: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		scope?: NativeCallScope,
		extraHeaders: Record<string, string> = {},
	): Promise<unknown> {
		return rawModernRequest(
			{
				createCliRequestTrace,
				options: this.#options,
				fetch: this.#fetch,
				transport: this.#transport,
				nativeScopes: this.#nativeScopes,
				sendTransportRequest: (...args) => this.#sendTransportRequest(...args),
				releaseNativeResumption: (requestId) =>
					this.#releaseNativeResumption(requestId),
			},
			method,
			params,
			signal,
			scope,
			extraHeaders,
		);
	}

	async #sendTransportRequest(
		request: JSONRPCMessage,
		headers: Record<string, string>,
		signal?: AbortSignal,
		allowAuthRetry = true,
		scope?: NativeCallScope,
	): Promise<unknown> {
		return sendTransportRequest(
			{
				transport: this.#transport,
				startTransport: () =>
					(this.#transportStarted ??= this.#transport!.start()),
				pendingTransport: this.#pendingTransport,
				registerNativeResumption: (...args) =>
					this.#registerNativeResumption(...args),
				oauthProvider: this.#oauthProvider,
				runOAuthTransaction: (operation) =>
					this.#runOAuthTransaction(operation),
				sendTransportRequest: (...args) => this.#sendTransportRequest(...args),
			},
			request,
			headers,
			signal,
			allowAuthRetry,
			scope,
		);
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
		return modernToolCallRounds(
			(...args) => this.#rawModernRequest(...args),
			toolName,
			args,
			options,
			protocol,
			scope,
		);
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

	async readHomeRun(homeRunId: string, signal?: AbortSignal): Promise<unknown> {
		return readHomeRun.call(this, homeRunId, signal);
	}
	async readHomeMessages(input: ReadHomeMessagesInput): Promise<unknown> {
		return readHomeMessages.call(this, input);
	}
	async readHomeRunSet(input: ReadHomeRunSetInput): Promise<unknown> {
		return readHomeRunSet.call(this, input);
	}
	async readHomeConversationTitle(
		conversationId: string,
	): Promise<string | undefined> {
		return readHomeConversationTitle.call(this, conversationId);
	}
	async listHomeConversations(
		input: ListHomeConversationsInput,
	): Promise<unknown> {
		return listHomeConversations.call(this, input);
	}
	async renameConversation(input: {
		conversationId: string;
		title: string;
	}): Promise<unknown> {
		return callHomeTool.call(this, "rename_conversation", {
			conversationId: input.conversationId,
			title: input.title,
		});
	}

	async pinConversation(input: {
		conversationId: string;
		pinned: boolean;
	}): Promise<unknown> {
		return callHomeTool.call(this, "pin_conversation", {
			conversationId: input.conversationId,
			pinned: input.pinned,
		});
	}

	async deleteConversation(input: {
		conversationId: string;
	}): Promise<unknown> {
		return callHomeTool.call(this, "delete_conversation", {
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
		return readDelegatedTediTraces.call(this, input);
	}
	async listKernelTraceBundles(
		input: ListKernelTraceBundlesInput,
	): Promise<unknown> {
		return listKernelTraceBundles.call(this, input);
	}
	async readHomeTrace(homeRunId: string): Promise<unknown> {
		return readHomeTrace.call(this, homeRunId);
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
		return readChildRunEvidence.call(this, input);
	}
	async readChildRunTree(input: ReadChildRunTreeInput): Promise<unknown> {
		return readChildRunTree.call(this, input);
	}
	async readHomeRunEvents(
		input: ReadHomeRunEventsInput,
		signal?: AbortSignal,
	): Promise<HomeRunEventsPage> {
		return readHomeRunEvents.call(this, input, signal);
	}
	async respondHomeApproval(input: {
		homeRunId: string;
		decision: "approve" | "reject";
		note?: string;
	}): Promise<unknown> {
		return callHomeTool.call(this, "respond_home_approval", {
			runId: input.homeRunId,
			decision: input.decision,
			...(input.note ? { note: input.note } : {}),
		});
	}

	async retryDelegation(workItemId: string): Promise<unknown> {
		return callHomeTool.call(this, "retry_delegation", { workItemId });
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
			callHomeTool.call(
				this,
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
		return callHomeTool.call(this, "steer_home_run", {
			runId: input.homeRunId,
			instruction: input.instruction,
		});
	}
}
