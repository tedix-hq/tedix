import { isRecord } from "@tedix/api-contract/utils/is-record";
import { resolveCliTaskInputResponses } from "./home-elicitation";
import {
	type JSONRPCMessage,
	InsufficientScopeError,
	type StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
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
import type {
	createCliRequestTrace,
	TedixHomeClientOptions,
	McpCallOptions,
} from "./home-client";
import { parseMcpResponsePayload } from "./home-payload";
import { CLI_VERSION } from "./shared";

/** One bounded typed call; never shared by unrelated callers or renewed by progress. */
export class NativeCallScope {
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

export async function rawModernRequest(
	context: {
		createCliRequestTrace: typeof createCliRequestTrace;
		options: Pick<TedixHomeClientOptions, "headers" | "url">;
		fetch: NonNullable<TedixHomeClientOptions["fetch"]>;
		transport: StreamableHTTPClientTransport | undefined;
		nativeScopes: Map<string, NativeCallScope>;
		sendTransportRequest: (
			request: JSONRPCMessage,
			headers: Record<string, string>,
			signal?: AbortSignal,
			allowAuthRetry?: boolean,
			scope?: NativeCallScope,
		) => Promise<unknown>;
		releaseNativeResumption: (requestId: string) => void;
	},
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
	const trace = context.createCliRequestTrace(
		context.options.headers,
		params._meta,
	);
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
		if (context.transport) {
			if (scope) context.nativeScopes.set(String(request.id), scope);
			try {
				return await context.sendTransportRequest(
					request,
					requestHeaders,
					signal,
					true,
					scope,
				);
			} finally {
				context.nativeScopes.delete(String(request.id));
				context.releaseNativeResumption(String(request.id));
			}
		}
		const fetching = context.fetch(context.options.url, {
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
			throw new Error(`MCP ${method} error: ${JSON.stringify(payload.error)}`);
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

export async function sendTransportRequest(
	context: {
		transport: StreamableHTTPClientTransport | undefined;
		startTransport: () => Promise<void>;
		pendingTransport: Map<
			string,
			{ resolve: (payload: { error?: unknown; result?: unknown }) => void }
		>;
		registerNativeResumption: (
			requestId: string,
			token: string,
			scope?: NativeCallScope,
		) => void;
		oauthProvider: TedixHomeClientOptions["oauthProvider"];
		runOAuthTransaction: (operation: () => Promise<void>) => Promise<void>;
		sendTransportRequest: (
			request: JSONRPCMessage,
			headers: Record<string, string>,
			signal?: AbortSignal,
			allowAuthRetry?: boolean,
			scope?: NativeCallScope,
		) => Promise<unknown>;
	},
	request: JSONRPCMessage,
	headers: Record<string, string>,
	signal?: AbortSignal,
	allowAuthRetry = true,
	scope?: NativeCallScope,
): Promise<unknown> {
	const transport = context.transport;
	if (!transport || !("id" in request) || request.id === undefined) {
		throw new Error("SDK MCP transport is not available");
	}
	const transportStarted = context.startTransport();
	if (scope) await scope.wait(transportStarted);
	else await transportStarted;
	const key = String(request.id);
	signal?.throwIfAborted();
	let onAbort = () => {};
	const response = new Promise<{ error?: unknown; result?: unknown }>(
		(resolve) => {
			context.pendingTransport.set(key, { resolve });
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
					context.registerNativeResumption(String(request.id), token, scope);
				},
			});
			if (scope) await scope.wait(sending);
			else await sending;
		} catch (error) {
			context.pendingTransport.delete(key);
			if (
				!scope &&
				allowAuthRetry &&
				error instanceof InsufficientScopeError &&
				error.requiredScope &&
				context.oauthProvider?.authorizeScopeChallenge
			) {
				const provider = context.oauthProvider;
				const scope = error.requiredScope;
				await context.runOAuthTransaction(() =>
					provider.authorizeScopeChallenge!(scope),
				);
				return context.sendTransportRequest(request, headers, signal, false);
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
		context.pendingTransport.delete(key);
	}
}

const MAX_SYNC_INPUT_ROUNDS = 8;
const CLI_CLIENT_INFO = { name: "tedix-cli", version: CLI_VERSION };
const CLI_CLIENT_CAPABILITIES = {
	elicitation: { form: {} },
	extensions: { [MCP_TASKS_EXTENSION]: {} },
};

export async function modernToolCallRounds(
	rawModernRequest: (
		method: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
		scope?: NativeCallScope,
	) => Promise<unknown>,
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
		result = await rawModernRequest(
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

export function registerNativeResumption(
	nativeResumptionTokens: Map<string, string>,
	nativeResumptions: Map<string, Map<string, NativeCallScope | undefined>>,
	releaseNativeResumption: (requestId: string) => void,
	requestId: string,
	token: string,
	scope?: NativeCallScope,
): void {
	// Keep only the latest SDK-issued token for each request. No live owner
	// is evicted when the finite connection registration limit is reached.
	if (
		!nativeResumptionTokens.has(requestId) &&
		nativeResumptionTokens.size >= 64
	) {
		const error = new Error("Native SSE active resumption limit exceeded");
		scope?.abort(error);
		throw error;
	}
	releaseNativeResumption(requestId);
	const owners =
		nativeResumptions.get(token) ??
		new Map<string, NativeCallScope | undefined>();
	owners.set(requestId, scope);
	nativeResumptions.set(token, owners);
	nativeResumptionTokens.set(requestId, token);
}
