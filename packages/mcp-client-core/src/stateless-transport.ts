import {
	CLIENT_CAPABILITIES_META_KEY,
	CLIENT_INFO_META_KEY,
	PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/client";
import {
	MCP_METHOD_HEADER,
	MCP_MODERN_PROTOCOL_VERSION,
	MCP_NAME_HEADER,
	MCP_PROTOCOL_VERSION_HEADER,
	mcpRequestTargetName,
} from "@tedix/mcp-shared/protocol";
import { collectBoundedMcpList } from "@tedix/mcp-shared/bounded-list";
import type { McpServerConfig } from "./types";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { guardedMcpFetch } from "./managed-fetch";
import {
	MODERN_CLIENT_INFO,
	statelessClientCapabilities,
} from "./client-capabilities";
import type {
	McpManagerOptions,
	McpDiscoveryCacheEvent,
} from "./client-manager";
import type {
	DiscoveryNegotiation,
	StatelessRequestContext,
	McpListKey,
	McpListSnapshots,
} from "./connections";
import {
	discoveryEndpoint,
	discoveryDigest,
	requestHeadersIdentity,
	normalizeDeclaredExtensions,
	DISCOVERY_NEGOTIATION_TTL_MS,
	MAX_DISCOVERY_NEGOTIATION_TTL_MS,
	TRANSIENT_DISCOVERY_NEGOTIATION_TTL_MS,
} from "./discovery-cache";
import {
	mapToolsListResult,
	mapResourcesListResult,
	mapResourceTemplatesListResult,
	mapPromptsListResult,
} from "./list-mappers";

class McpJsonRpcError extends Error {
	readonly code: number;
	readonly data?: unknown;
	readonly status: number;

	constructor(
		method: string,
		status: number,
		error: { code: number; message?: string; data?: unknown },
	) {
		super(
			`MCP ${method} error (${error.code}): ${error.message ?? "Unknown JSON-RPC error"}`,
		);
		this.name = "McpJsonRpcError";
		this.code = error.code;
		this.data = error.data;
		this.status = status;
	}
}

export function isHeaderMismatchError(error: unknown): boolean {
	return error instanceof McpJsonRpcError && error.code === -32020;
}

export function createStatelessTransport(
	options: Pick<
		McpManagerOptions,
		"onDiscoveryCacheEvent" | "optionalSnapshotListTimeoutMs"
	>,
	resolveRequestHeaders: (
		config: McpServerConfig,
	) => Promise<Record<string, string>>,
	outboundTraceContext: () => {
		headers: Record<string, string>;
		meta: Record<string, unknown>;
	},
) {
	const { onDiscoveryCacheEvent, optionalSnapshotListTimeoutMs } = options;
	const discoveryNegotiations = new Map<string, DiscoveryNegotiation>();
	const discoveryNegotiationInFlight = new Map<
		string,
		Promise<DiscoveryNegotiation>
	>();
	const MAX_SYNC_INPUT_ROUNDS = 8;
	function emitDiscoveryCacheEvent(
		config: McpServerConfig,
		outcome: McpDiscoveryCacheEvent["outcome"],
		negotiation: DiscoveryNegotiation,
	): void {
		try {
			onDiscoveryCacheEvent?.({
				outcome,
				endpoint: discoveryEndpoint(config.url),
				modern: negotiation.modern,
				ttlMs: negotiation.ttlMs,
				...(negotiation.digest ? { digest: negotiation.digest } : {}),
			});
		} catch {
			// Observability must never break protocol negotiation.
		}
	}

	/**
	 * Detect whether this URL + resolved credential/header identity advertises
	 * the 2026-07-28 revision. The verdict and its extension metadata share one
	 * bounded cache entry. Transient failures get only a short negative TTL.
	 */
	async function negotiateModernProtocol(
		config: McpServerConfig,
		headers: Record<string, string>,
	): Promise<DiscoveryNegotiation> {
		const identity = await requestHeadersIdentity(headers);
		const cacheKey = `${config.url}\n${identity}`;
		const now = Date.now();
		const cached = discoveryNegotiations.get(cacheKey);
		if (cached && now < cached.expiresAt) {
			emitDiscoveryCacheEvent(config, "hit", cached);
			return cached;
		}
		if (cached) discoveryNegotiations.delete(cacheKey);

		const inFlight = discoveryNegotiationInFlight.get(cacheKey);
		if (inFlight) return inFlight;

		const probe = (async (): Promise<DiscoveryNegotiation> => {
			let modern = false;
			let completions = false;
			let extensions: Record<string, Record<string, unknown>> = {};
			let ttl = TRANSIENT_DISCOVERY_NEGOTIATION_TTL_MS;
			let digest: string | undefined;
			try {
				const res = await guardedMcpFetch(config.url, {
					method: "POST",
					headers: {
						...headers,
						"Accept-Encoding": "identity",
						"Content-Type": "application/json",
						Accept: "application/json, text/event-stream",
						[MCP_PROTOCOL_VERSION_HEADER]: MCP_MODERN_PROTOCOL_VERSION,
						[MCP_METHOD_HEADER]: "server/discover",
					},
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: crypto.randomUUID(),
						method: "server/discover",
						params: {
							_meta: {
								[PROTOCOL_VERSION_META_KEY]: MCP_MODERN_PROTOCOL_VERSION,
								[CLIENT_INFO_META_KEY]: MODERN_CLIENT_INFO,
								[CLIENT_CAPABILITIES_META_KEY]:
									statelessClientCapabilities(config),
							},
						},
					}),
				});
				if (res.ok) {
					ttl = DISCOVERY_NEGOTIATION_TTL_MS;
					const payload = parseMcpResponsePayload(
						await res.text(),
						"server/discover",
					);
					const result = payload.result as
						| {
								supportedVersions?: unknown;
								capabilities?: unknown;
								ttlMs?: unknown;
								cacheScope?: unknown;
						  }
						| undefined;
					if (result) digest = await discoveryDigest(result);
					if (
						result?.cacheScope === "private" &&
						typeof result.ttlMs === "number" &&
						Number.isInteger(result.ttlMs) &&
						result.ttlMs >= 0
					) {
						ttl = Math.min(result.ttlMs, MAX_DISCOVERY_NEGOTIATION_TTL_MS);
					}
					const versions = result?.supportedVersions;
					modern =
						Array.isArray(versions) &&
						versions.includes(MCP_MODERN_PROTOCOL_VERSION);
					const capabilities = isRecord(result?.capabilities)
						? result.capabilities
						: undefined;
					completions = Boolean(capabilities?.completions);
					extensions = normalizeDeclaredExtensions(capabilities?.extensions);
				} else if (
					res.status !== 408 &&
					res.status !== 425 &&
					res.status !== 429 &&
					res.status < 500
				) {
					// A stable unsupported/auth response is a bounded legacy verdict.
					ttl = DISCOVERY_NEGOTIATION_TTL_MS;
				}
			} catch (error) {
				// Never collapse SSRF/URL containment into a protocol-version error.
				if (
					error instanceof Error &&
					/(Blocked host|Invalid URL|Private|loopback|link-local)/i.test(
						error.message,
					)
				) {
					throw error;
				}
				// Transient discovery failures are cached only briefly.
			}
			const verdict = {
				modern,
				completions,
				extensions,
				ttlMs: ttl,
				...(digest ? { digest } : {}),
				expiresAt: Date.now() + ttl,
			};
			discoveryNegotiations.set(cacheKey, verdict);
			emitDiscoveryCacheEvent(config, "miss", verdict);
			return verdict;
		})();
		discoveryNegotiationInFlight.set(cacheKey, probe);
		try {
			return await probe;
		} finally {
			discoveryNegotiationInFlight.delete(cacheKey);
		}
	}

	async function resolveStatelessRequestContext(
		config: McpServerConfig,
	): Promise<StatelessRequestContext> {
		const headers = await resolveRequestHeaders(config);
		const negotiation = await negotiateModernProtocol(config, headers);
		if (!negotiation.modern) {
			throw new Error(
				`Unsupported MCP server at ${config.url}: server/discover must advertise ${MCP_MODERN_PROTOCOL_VERSION}`,
			);
		}
		return {
			headers,
			negotiation,
		};
	}

	/**
	 * Build the 2026-07-28 request-bound headers + `_meta`. `Mcp-Method` and
	 * `Mcp-Name` are always added (legacy servers ignore unknown headers);
	 * `MCP-Protocol-Version` is only declared when the server negotiated modern,
	 * so a strict modern server enforces the full contract while legacy/external
	 * servers are unaffected.
	 */
	function modernRequestHeaders(
		method: string,
		params: Record<string, unknown> | undefined,
		modern: boolean,
	): Record<string, string> {
		const headers: Record<string, string> = { [MCP_METHOD_HEADER]: method };
		const target = mcpRequestTargetName(method, params);
		if (target) headers[MCP_NAME_HEADER] = target;
		if (modern)
			headers[MCP_PROTOCOL_VERSION_HEADER] = MCP_MODERN_PROTOCOL_VERSION;
		return headers;
	}

	async function rawMcpPost(
		config: McpServerConfig,
		method: string,
		params?: Record<string, unknown>,
		extraHeaders?: Record<string, string>,
		requestContext?: StatelessRequestContext,
		signal?: AbortSignal,
	): Promise<unknown> {
		signal?.throwIfAborted();
		let result = await rawMcpPostOnce(
			config,
			method,
			params,
			extraHeaders,
			requestContext,
			signal,
		);

		// 2026-07-28 synchronous MRTR. A tool/handler may answer a `tools/call`
		// directly (no Tasks round-trip) with `resultType: "input_required"`,
		// carrying `inputRequests` + an opaque `requestState`. When an
		// `onTaskInputRequired` resolver is configured, gather responses and RETRY
		// the original request with `inputResponses` + the echoed `requestState`
		// (a fresh JSON-RPC id is minted per attempt by `rawMcpPostOnce`). This
		// mirrors the async `tasks/update` flow without a task id.
		if (!config.onTaskInputRequired) return result;
		let nextParams = params;
		for (let round = 0; round < MAX_SYNC_INPUT_ROUNDS; round++) {
			if (!isRecord(result) || result.resultType !== "input_required") {
				return result;
			}
			const inputRequests = isRecord(result.inputRequests)
				? result.inputRequests
				: {};
			const responses = await config.onTaskInputRequired({
				taskId: typeof result.taskId === "string" ? result.taskId : "",
				inputRequests,
			});
			if (!responses) return result; // cannot fulfill — surface to caller
			nextParams = {
				...nextParams,
				inputResponses: responses,
				...(result.requestState !== undefined
					? { requestState: result.requestState }
					: {}),
			};
			result = await rawMcpPostOnce(
				config,
				method,
				nextParams,
				extraHeaders,
				requestContext,
				signal,
			);
		}
		return result;
	}

	async function rawMcpPostOnce(
		config: McpServerConfig,
		method: string,
		params?: Record<string, unknown>,
		extraHeaders?: Record<string, string>,
		requestContext?: StatelessRequestContext,
		signal?: AbortSignal,
	): Promise<unknown> {
		signal?.throwIfAborted();
		const context =
			requestContext ?? (await resolveStatelessRequestContext(config));
		const { headers } = context;
		const modern = context.negotiation.modern;
		const trace = outboundTraceContext();
		// Only declare the 2026-07-28 `_meta` contract when the server negotiated
		// modern. Stamping protocolVersion without the matching MCP-Protocol-Version
		// header makes a dual-era server reject the request for header/_meta
		// inconsistency (`-32004`). Legacy requests carry only trace `_meta`.
		const meta: Record<string, unknown> = {
			...(params && typeof params._meta === "object" && params._meta !== null
				? (params._meta as Record<string, unknown>)
				: {}),
			...trace.meta,
			...(modern
				? {
						[PROTOCOL_VERSION_META_KEY]: MCP_MODERN_PROTOCOL_VERSION,
						[CLIENT_INFO_META_KEY]: MODERN_CLIENT_INFO,
						[CLIENT_CAPABILITIES_META_KEY]: statelessClientCapabilities(config),
					}
				: {}),
		};
		const outboundParams =
			Object.keys(meta).length > 0 ? { ...params, _meta: meta } : { ...params };
		signal?.throwIfAborted();
		const res = await guardedMcpFetch(config.url, {
			signal,
			method: "POST",
			headers: {
				...headers,
				...trace.headers,
				...modernRequestHeaders(method, params, modern),
				...extraHeaders,
				"Accept-Encoding": "identity",
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: crypto.randomUUID(),
				method,
				params: outboundParams,
			}),
		});
		const text = await res.text();
		let payload: { result?: unknown; error?: unknown };
		try {
			payload = parseMcpResponsePayload(text, method);
		} catch (error) {
			if (!res.ok) {
				throw new Error(
					`Stateless MCP ${method} failed (${res.status}): ${text.slice(0, 500)}`,
					{ cause: error },
				);
			}
			throw error;
		}
		if (isRecord(payload.error) && typeof payload.error.code === "number") {
			throw new McpJsonRpcError(method, res.status, {
				code: payload.error.code,
				message:
					typeof payload.error.message === "string"
						? payload.error.message
						: undefined,
				data: payload.error.data,
			});
		}
		if (payload.error) {
			throw new Error(`MCP ${method} error: ${JSON.stringify(payload.error)}`);
		}
		if (!res.ok) {
			throw new Error(
				`Stateless MCP ${method} failed (${res.status}): ${text.slice(0, 500)}`,
			);
		}
		return payload.result;
	}

	function parseMcpResponsePayload(
		text: string,
		method: string,
	): { result?: unknown; error?: unknown } {
		const trimmed = text.trim();
		if (!trimmed) {
			throw new Error(`MCP ${method} returned an empty response`);
		}
		if (trimmed.startsWith("{")) {
			return JSON.parse(trimmed) as { result?: unknown; error?: unknown };
		}

		for (const event of trimmed.split(/\r?\n\r?\n/).reverse()) {
			const data = event
				.split(/\r?\n/)
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trimStart())
				.join("\n")
				.trim();
			if (!data || data === "[DONE]") continue;
			if (data.startsWith("{")) {
				return JSON.parse(data) as { result?: unknown; error?: unknown };
			}
		}

		throw new Error(
			`MCP ${method} returned unsupported response content: ${trimmed.slice(0, 120)}`,
		);
	}

	async function rawMcpListAll(
		config: McpServerConfig,
		method: string,
		key: McpListKey,
		requestContext?: StatelessRequestContext,
	): Promise<Record<string, unknown[]>> {
		// The upstream is untrusted: a constant or endless nextCursor must not spin
		// the runtime, so the walk is bounded (pages, items, bytes, repeat cursor).
		const { items, truncated } = await collectBoundedMcpList<unknown>(
			async (cursor) => {
				const result = (await rawMcpPost(
					config,
					method,
					cursor === undefined ? undefined : { cursor },
					undefined,
					requestContext,
				)) as Record<string, unknown>;
				const pageItems = result[key];
				if (!Array.isArray(pageItems)) {
					throw new Error(`MCP ${method} result is missing ${key}`);
				}
				return { items: pageItems, nextCursor: result.nextCursor };
			},
		);
		if (truncated) {
			console.warn(
				`[mcp-list] ${method} truncated at ${items.length} ${key} (page, item, byte, or repeated-cursor bound)`,
			);
		}
		return { [key]: items };
	}

	async function loadStatelessSnapshot(
		serverId: string,
		config: McpServerConfig,
	): Promise<McpListSnapshots> {
		// Per-leg latency probe (non-behavioral): attribute the cold connect wall
		// clock across request-context setup (server/discover + credential header
		// resolve) and each of the four lists, so the timeout-vs-value decision is
		// made on measurement. Each list logs its REAL latency even when the
		// optional cap below rejects the race early. Pairs with tedi-runtime's
		// `[mcp-cred-timing]`.
		const ctx0 = performance.now();
		const requestContext = await resolveStatelessRequestContext(config);
		console.log(
			`[mcp-list-timing] ${serverId} request-context ms=${Math.round(performance.now() - ctx0)}`,
		);
		const timedRaw = (
			method: string,
			key: McpListKey,
		): Promise<Record<string, unknown[]>> => {
			const t = performance.now();
			return rawMcpListAll(config, method, key, requestContext).then(
				(result) => {
					console.log(
						`[mcp-list-timing] ${serverId} ${method} ms=${Math.round(performance.now() - t)} ok=true`,
					);
					return result;
				},
				(error: unknown) => {
					console.log(
						`[mcp-list-timing] ${serverId} ${method} ms=${Math.round(performance.now() - t)} ok=false`,
					);
					throw error;
				},
			);
		};
		// `tools/list` is required and governed by the outer connect timeout. The
		// other three lists are optional (they degrade to `[]` below), so a slow
		// one must not gate the snapshot behind its latency — bound each to
		// `optionalSnapshotListTimeoutMs` when configured so it rejects (→ `[]`)
		// instead of holding the whole `Promise.allSettled` open. See the option's
		// doc for the aggregate-gateway `resources/list` case this guards.
		const optionalList = (
			method: string,
			key: McpListKey,
		): Promise<Record<string, unknown[]>> => {
			const list = timedRaw(method, key);
			const bound = optionalSnapshotListTimeoutMs;
			if (bound === undefined || bound <= 0) return list;
			return Promise.race([
				list,
				new Promise<never>((_, reject) => {
					const timer = setTimeout(
						() =>
							reject(
								new Error(
									`MCP ${method} timed out after ${bound}ms (optional snapshot list)`,
								),
							),
						bound,
					);
					// Never let the losing timer keep the promise (or a worker) alive.
					list.finally(() => clearTimeout(timer)).catch(() => {});
				}),
			]);
		};
		const [toolsResult, resourcesResult, templatesResult, promptsResult] =
			await Promise.allSettled([
				timedRaw("tools/list", "tools"),
				optionalList("resources/list", "resources"),
				optionalList("resources/templates/list", "resourceTemplates"),
				optionalList("prompts/list", "prompts"),
			]);

		if (toolsResult.status === "rejected") {
			throw toolsResult.reason;
		}

		return {
			tools: mapToolsListResult(serverId, toolsResult.value),
			resources:
				resourcesResult.status === "fulfilled"
					? mapResourcesListResult(serverId, resourcesResult.value)
					: [],
			resourceTemplates:
				templatesResult.status === "fulfilled"
					? mapResourceTemplatesListResult(serverId, templatesResult.value)
					: [],
			prompts:
				promptsResult.status === "fulfilled"
					? mapPromptsListResult(serverId, promptsResult.value)
					: [],
			capabilities: {
				tools: true,
				resources: resourcesResult.status === "fulfilled",
				resourceTemplates: templatesResult.status === "fulfilled",
				prompts: promptsResult.status === "fulfilled",
				completions: requestContext.negotiation.completions,
			},
			extensions: requestContext.negotiation.extensions,
		};
	}

	return {
		rawMcpPost,
		rawMcpListAll,
		loadStatelessSnapshot,
		resolveStatelessRequestContext,
		modernRequestHeaders,
	};
}
