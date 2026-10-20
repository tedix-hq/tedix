import {
	type AuthProvider,
	Client,
	type ClientCapabilities,
	ProtocolError,
	ProtocolErrorCode,
	StreamableHTTPClientTransport,
	TRACEPARENT_META_KEY,
	TRACESTATE_META_KEY,
} from "@modelcontextprotocol/client";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/client/validators/cf-worker";
import { buildMcpParamHeaders } from "@tedix/mcp-shared/mcp-param-headers";
import {
	MCP_MODERN_PROTOCOL_VERSION,
	MCP_TASKS_EXTENSION,
} from "@tedix/mcp-shared/protocol";
import { type McpTaskState } from "@tedix/mcp-shared/tasks";
import {
	GetSkillResultSchema,
	ListSkillsResultSchema,
	MCP_SKILLS_EXTENSION,
} from "@tedix/mcp-shared/skills";
import {
	outboundTraceMeta,
	type TraceContext,
} from "@tedix/mcp-shared/trace-context";
import type {
	McpConnection,
	McpGuidanceInfo,
	McpPromptInfo,
	McpResourceInfo,
	McpResourceTemplateInfo,
	McpServerConfig,
	McpToolInfo,
} from "./types";
import { createAgentElicitationResolver } from "./elicitation-resolver";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { guardedMcpFetch } from "./managed-fetch";
import { MODERN_CLIENT_INFO } from "./client-capabilities";
import {
	createStatelessTransport,
	isHeaderMismatchError,
} from "./stateless-transport";
import { createTaskClient } from "./tasks";
import {
	mapToolsListResult,
	mapResourcesListResult,
	mapResourceTemplatesListResult,
	mapPromptsListResult,
} from "./list-mappers";
import {
	isAuthRecoveryError,
	isTransportRecoveryError,
	authRecoveryMessageFromResult,
} from "./recovery";
import {
	readGuidanceResult,
	guidanceNameFromUri,
	buildGuidanceResourceSummaries,
} from "./guidance";
import {
	requestHeadersIdentity,
	priorDiscoveryFromConnection,
	normalizeDeclaredExtensions,
	SDK_PRIOR_DISCOVERY_TTL_MS,
} from "./discovery-cache";
import type {
	ManagedConnection,
	BoundedPriorDiscovery,
	ConnectionSnapshot,
	StatelessManagedConnection,
} from "./connections";

const MCP_CLIENT_JSON_SCHEMA_VALIDATOR = new CfWorkerJsonSchemaValidator({
	draft: "2020-12",
});

/**
 * MCP 2026-07-28 `completion/complete` (autocomplete) request/response shapes.
 * `ref/prompt` completes a prompt argument; `ref/resource` completes a
 * resource URI-template variable.
 */
export type McpCompletionRef =
	| {
			type: "ref/prompt";
			name: string;
	  }
	| {
			type: "ref/resource";
			uri: string;
	  };

export interface McpCompletionResult {
	values: string[];
	total?: number;
	hasMore?: boolean;
}

export interface McpManagerOptions {
	/** Request-only hosts discover optional guidance only when explicitly refreshed. */
	deferOptionalDiscovery?: boolean;
	guidanceMaxChars?: number;
	guidanceSummaryMaxChars?: number;
	disabledSkills?: string[];
	traceContext?: () => TraceContext | null | undefined;
	/** Bounded, credential-free visibility into private discovery cache behavior. */
	onDiscoveryCacheEvent?: (event: McpDiscoveryCacheEvent) => void;
	/**
	 * Per-call timeout for the OPTIONAL stateless-snapshot lists
	 * (`resources/list`, `resources/templates/list`, `prompts/list`). The
	 * required `tools/list` is never bounded here — the outer connect timeout
	 * governs it. A slow optional list that crosses this bound degrades to an
	 * empty result (exactly like a rejected list) instead of gating the whole
	 * snapshot behind its latency.
	 *
	 * Why this exists: on an aggregate gateway `resources/list` enumerates skill
	 * resources across every assigned app and can run 8-10 s while `tools/list`
	 * returns in ~1.5 s. `loadStatelessSnapshot` awaits all four via
	 * `Promise.allSettled`, so without this bound the optional lists set the
	 * connect wall clock — pushing a Code-Mode connect past a tight
	 * `connectTimeoutMs` and poisoning the caller's sync-failure backoff even
	 * though the tool surface the turn needs was ready seconds earlier.
	 *
	 * Undefined (default) = unbounded, preserving prior behavior for callers
	 * with a generous connect budget.
	 */
	optionalSnapshotListTimeoutMs?: number;
}

export interface McpDiscoveryCacheEvent {
	outcome: "hit" | "miss";
	endpoint: string;
	modern: boolean;
	ttlMs: number;
	/** Stable SHA-256 of the discovery result, never of request headers. */
	digest?: string;
}

function connectionSupportsDirectoryRead(conn: ConnectionSnapshot): boolean {
	return Boolean(conn.extensions[MCP_SKILLS_EXTENSION]?.directoryRead);
}

function connectionSupportsSkills(conn: ConnectionSnapshot): boolean {
	return Object.hasOwn(conn.extensions, MCP_SKILLS_EXTENSION);
}

function createMcpClient(
	capabilities: ClientCapabilities = {},
	onListChanged?: () => void,
): Client {
	return new Client(MODERN_CLIENT_INFO, {
		capabilities,
		jsonSchemaValidator: MCP_CLIENT_JSON_SCHEMA_VALIDATOR,
		...(onListChanged
			? {
					// SDK v2 maps these handlers to unsolicited legacy notifications or
					// auto-opens one 2026 subscriptions/listen stream as appropriate.
					listChanged: {
						tools: { onChanged: () => onListChanged() },
						resources: { onChanged: () => onListChanged() },
						prompts: { onChanged: () => onListChanged() },
					},
				}
			: {}),
		// Current-only: pin the finalized revision so the SDK never probes and
		// falls back to an initialize/session handshake.
		versionNegotiation: { mode: { pin: MCP_MODERN_PROTOCOL_VERSION } },
	});
}

export class McpClientManager {
	private rawMcpPost(
		...args: Parameters<
			ReturnType<typeof createStatelessTransport>["rawMcpPost"]
		>
	): Promise<unknown> {
		return this.stateless.rawMcpPost(...args);
	}
	private rawMcpListAll(
		...args: Parameters<
			ReturnType<typeof createStatelessTransport>["rawMcpListAll"]
		>
	): Promise<Record<string, unknown[]>> {
		return this.stateless.rawMcpListAll(...args);
	}
	private readonly stateless;
	private readonly tasks;
	private connections = new Map<string, ManagedConnection>();
	private reconnectInFlight = new Map<string, Promise<ManagedConnection>>();
	private readonly maxConnections: number;
	private readonly guidanceMaxChars: number;
	private readonly guidanceSummaryMaxChars: number;
	private readonly disabledSkills: Set<string>;
	private readonly traceContext?: () => TraceContext | null | undefined;
	private readonly deferOptionalDiscovery: boolean;

	constructor(maxConnections = 50, options: McpManagerOptions = {}) {
		this.maxConnections = maxConnections;
		this.stateless = createStatelessTransport(
			options,
			(config) => this.resolveRequestHeaders(config),
			() => this.outboundTraceContext(),
		);
		this.tasks = createTaskClient(
			this.stateless,
			(serverId) => this.taskServerConfig(serverId),
			() => this.outboundTraceContext(),
		);
		this.deferOptionalDiscovery = options.deferOptionalDiscovery ?? false;
		this.guidanceMaxChars = options.guidanceMaxChars ?? 4000;
		this.guidanceSummaryMaxChars = options.guidanceSummaryMaxChars ?? 220;
		this.disabledSkills = new Set(options.disabledSkills ?? []);
		this.traceContext = options.traceContext;
	}

	private async resolveRequestHeaders(
		config: McpServerConfig,
	): Promise<Record<string, string>> {
		const headers = {
			"Accept-Encoding": "identity",
			...config.headers,
		};
		if (config.headerFactory) {
			Object.assign(headers, await config.headerFactory());
		}
		return headers;
	}

	private extractBearerToken(
		headers: Record<string, string>,
	): string | undefined {
		for (const [key, value] of Object.entries(headers)) {
			if (key.toLowerCase() !== "authorization") continue;
			const match = value.match(/^Bearer\s+(.+)$/i);
			return match?.[1]?.trim();
		}
		return undefined;
	}

	private withoutAuthorizationHeader(
		headers: Record<string, string>,
	): Record<string, string> {
		return Object.fromEntries(
			Object.entries(headers).filter(
				([key]) => key.toLowerCase() !== "authorization",
			),
		);
	}

	private createSdkAuthProvider(
		config: McpServerConfig,
		initialToken: string,
	): AuthProvider {
		let firstToken: string | undefined = initialToken;
		return {
			token: async () => {
				if (firstToken !== undefined) {
					const token = firstToken;
					firstToken = undefined;
					return token;
				}
				const headers = await this.resolveRequestHeaders(config);
				return this.extractBearerToken(headers);
			},
			onUnauthorized: async () => {
				config.onCredentialInvalidate?.(config.url);
			},
		};
	}

	private async createSdkTransport(config: McpServerConfig): Promise<{
		transport: StreamableHTTPClientTransport;
		authContextKey: string;
	}> {
		const headers = await this.resolveRequestHeaders(config);
		const bearerToken = this.extractBearerToken(headers);
		const hasBearerToken = Boolean(bearerToken);
		const staticHeaders = hasBearerToken
			? this.withoutAuthorizationHeader(headers)
			: headers;
		const transport = new StreamableHTTPClientTransport(new URL(config.url), {
			...(hasBearerToken
				? {
						authProvider: this.createSdkAuthProvider(
							config,
							bearerToken as string,
						),
					}
				: {}),
			requestInit: { headers: staticHeaders },
			fetch: (url, init) => {
				const headers = new Headers(init?.headers);
				for (const [key, value] of Object.entries(
					this.outboundTraceContext().headers,
				))
					headers.set(key, value);
				return guardedMcpFetch(String(url), { ...init, headers });
			},
			onInsufficientScope: "throw",
		});
		return {
			transport,
			authContextKey: await requestHeadersIdentity(headers),
		};
	}

	private outboundTraceContext(): {
		headers: Record<string, string>;
		meta: Record<string, unknown>;
	} {
		const context = this.traceContext?.();
		const extraMeta =
			context?.metadata && typeof context.metadata === "object"
				? context.metadata
				: {};
		const traceId =
			typeof context?.traceId === "string" ? context.traceId.trim() : "";
		if (!traceId) return { headers: {}, meta: { ...extraMeta } };
		const meta = outboundTraceMeta(traceId, context?.tracestate ?? undefined);
		const headers: Record<string, string> = {
			"X-Trace-Id": traceId,
			"X-Tedix-Trace-Id": traceId,
		};
		if (meta[TRACEPARENT_META_KEY]) {
			headers.traceparent = meta[TRACEPARENT_META_KEY];
		}
		if (meta[TRACESTATE_META_KEY]) {
			headers.tracestate = meta[TRACESTATE_META_KEY];
		}
		return { headers, meta: { ...extraMeta, ...meta } };
	}

	private async openConnection(
		serverId: string,
		config: McpServerConfig,
		priorDiscovery?: BoundedPriorDiscovery,
		signal?: AbortSignal,
	): Promise<ManagedConnection> {
		const transportType = "streamable-http";
		const capabilities: Record<string, unknown> = {
			// Tasks extension: SDK-path tool results are still polled to terminal
			// state via resolveTaskResult, so this path drives the same
			// tasks/get|update round-trip as the stateless path and must say so —
			// previously only the raw stateless `_meta` declared it (split-brain).
			extensions: { [MCP_TASKS_EXTENSION]: {} },
		};
		// Declare elicitation support (form mode) so servers can request user input.
		// Sampling (`sampling/createMessage`) is intentionally NOT advertised — it is
		// removed in the finalized MCP revision; tedis use direct model integration.
		capabilities.elicitation = { form: {} };
		const client = createMcpClient(
			capabilities,
			this.deferOptionalDiscovery
				? undefined
				: () => {
						void this.refreshConnection(serverId).catch(() => {
							// Non-fatal: the next manual refresh will reconcile state.
						});
					},
		);

		this.registerElicitationHandler(client);

		const { transport, authContextKey } = await this.createSdkTransport(config);
		const reusablePrior =
			priorDiscovery?.authContextKey === authContextKey
				? priorDiscovery
				: undefined;

		// SDK v2 discovery probing precedes request-signal wiring. Closing its
		// transport aborts the probe through the SDK lifecycle as well.
		const abortConnect = () => void transport.close().catch(() => {});
		signal?.addEventListener("abort", abortConnect, { once: true });
		try {
			signal?.throwIfAborted();
			await client.connect(transport, {
				...(reusablePrior ? { prior: reusablePrior.prior } : {}),
				signal,
			});
			signal?.throwIfAborted();
		} catch (error) {
			await client.close().catch(() => {});
			throw error;
		} finally {
			signal?.removeEventListener("abort", abortConnect);
		}
		if (!client.getDiscoverResult()) {
			await client.close().catch(() => {});
			throw new Error(
				`Unsupported MCP server at ${config.url}: server/discover must advertise ${MCP_MODERN_PROTOCOL_VERSION}`,
			);
		}

		const serverVersion = client.getServerVersion();
		const serverCapabilities = client.getServerCapabilities();
		const resourcesCapability = serverCapabilities?.resources;
		const connectionInfo: McpConnection = {
			serverId,
			url: config.url,
			transport: transportType,
			connectedAt: new Date().toISOString(),
			serverName: serverVersion?.name,
			serverVersion: serverVersion?.version,
			capabilities: {
				tools: Boolean(serverCapabilities?.tools),
				resources: Boolean(resourcesCapability),
				resourceTemplates: Boolean(
					resourcesCapability &&
					typeof resourcesCapability === "object" &&
					"templates" in resourcesCapability,
				),
				prompts: Boolean(serverCapabilities?.prompts),
				completions: Boolean(
					(serverCapabilities as { completions?: unknown } | undefined)
						?.completions,
				),
			},
		};

		return {
			mode: "sdk",
			client,
			transport,
			authContextKey,
			priorDiscoveryExpiresAt:
				reusablePrior?.expiresAt ?? Date.now() + SDK_PRIOR_DISCOVERY_TTL_MS,
			config,
			info: connectionInfo,
			tools: [],
			resources: [],
			resourceTemplates: [],
			prompts: [],
			guidance: [],
			extensions: normalizeDeclaredExtensions(serverCapabilities?.extensions),
		};
	}

	async connect(
		serverId: string,
		config: McpServerConfig,
		options?: { signal?: AbortSignal; priorDiscovery?: BoundedPriorDiscovery },
	): Promise<McpConnection> {
		if (this.connections.has(serverId)) {
			await this.disconnect(serverId);
		}
		if (this.connections.size >= this.maxConnections) {
			throw new Error(
				`Maximum connections (${this.maxConnections}) reached. Disconnect a server first.`,
			);
		}

		const connection = await this.openConnection(
			serverId,
			config,
			options?.priorDiscovery,
			options?.signal,
		);
		try {
			if (this.deferOptionalDiscovery && connection.mode === "sdk") {
				const result = await connection.client.listTools(undefined, {
					signal: options?.signal,
				});
				options?.signal?.throwIfAborted();
				connection.tools = mapToolsListResult(serverId, result);
				this.connections.set(serverId, connection);
			} else {
				this.connections.set(serverId, connection);
				await this.refreshConnection(serverId, { allowRecovery: false });
			}
			return connection.info;
		} catch (error) {
			if (this.connections.get(serverId) === connection)
				this.connections.delete(serverId);
			await this.closeConnection(connection).catch(() => {});
			throw error;
		}
	}

	async connectStatelessSnapshot(
		serverId: string,
		config: McpServerConfig,
	): Promise<McpConnection> {
		if (this.connections.has(serverId)) {
			await this.disconnect(serverId);
		}
		if (this.connections.size >= this.maxConnections) {
			throw new Error(
				`Maximum connections (${this.maxConnections}) reached. Disconnect a server first.`,
			);
		}

		const snapshot = await this.stateless.loadStatelessSnapshot(
			serverId,
			config,
		);
		const connectionInfo: McpConnection = {
			serverId,
			url: config.url,
			transport: "streamable-http",
			connectedAt: new Date().toISOString(),
			capabilities: snapshot.capabilities,
		};
		const conn: StatelessManagedConnection = {
			mode: "stateless",
			config,
			info: connectionInfo,
			tools: snapshot.tools,
			resources: snapshot.resources,
			resourceTemplates: snapshot.resourceTemplates,
			prompts: snapshot.prompts,
			guidance: [],
			extensions: snapshot.extensions,
		};
		await this.mergeSkillIndex(conn, serverId, conn.resources);
		conn.guidance = buildGuidanceResourceSummaries(
			conn,
			this.disabledSkills,
			this.guidanceSummaryMaxChars,
		);
		this.connections.set(serverId, conn);
		return conn.info;
	}

	private async closeConnection(conn: ManagedConnection): Promise<void> {
		if (conn.mode !== "sdk") return;
		const transport = conn.transport as StreamableHTTPClientTransport & {
			terminateSession?: () => Promise<void>;
		};
		await transport.terminateSession?.().catch(() => {});
		await conn.client.close();
	}

	private async refreshStatelessConnection(
		serverId: string,
		conn: StatelessManagedConnection,
	): Promise<McpConnection> {
		const snapshot = await this.stateless.loadStatelessSnapshot(
			serverId,
			conn.config,
		);
		conn.tools = snapshot.tools;
		conn.resources = snapshot.resources;
		conn.resourceTemplates = snapshot.resourceTemplates;
		conn.prompts = snapshot.prompts;
		conn.info.capabilities = snapshot.capabilities;
		conn.extensions = snapshot.extensions;
		await this.mergeSkillIndex(conn, serverId, conn.resources);
		conn.guidance = buildGuidanceResourceSummaries(
			conn,
			this.disabledSkills,
			this.guidanceSummaryMaxChars,
		);
		return conn.info;
	}

	async disconnect(serverId: string): Promise<void> {
		const conn = this.connections.get(serverId);
		if (!conn) throw new Error(`Connection "${serverId}" not found.`);
		try {
			await this.closeConnection(conn);
		} catch {
			// Already closed.
		}
		this.connections.delete(serverId);
	}

	async disconnectAll(): Promise<void> {
		await Promise.allSettled(
			[...this.connections.keys()].map((id) => this.disconnect(id)),
		);
	}

	listConnections(): McpConnection[] {
		return [...this.connections.values()].map((connection) => connection.info);
	}

	private async reconnect(
		serverId: string,
		signal?: AbortSignal,
	): Promise<ManagedConnection> {
		const existing = this.reconnectInFlight.get(serverId);
		if (existing) return existing;

		const current = this.connections.get(serverId);
		if (!current) throw new Error(`Connection "${serverId}" not found.`);

		const reconnectPromise = (async () => {
			const config = current.config;
			const priorDiscovery = priorDiscoveryFromConnection(current);
			// Invalidate cached credentials so headerFactory fetches a fresh token
			if (config.onCredentialInvalidate) {
				config.onCredentialInvalidate(config.url);
			}
			try {
				await this.closeConnection(current);
			} catch {
				// Already closed.
			}
			this.connections.delete(serverId);
			if (current.mode === "stateless") {
				await this.connectStatelessSnapshot(serverId, config);
			} else if (this.deferOptionalDiscovery) {
				await this.connect(serverId, config, { signal, priorDiscovery });
			} else {
				const reopened = await this.openConnection(
					serverId,
					config,
					priorDiscovery,
				);
				this.connections.set(serverId, reopened);
				await this.refreshConnection(serverId, { allowRecovery: false });
			}
			return this.connections.get(serverId)!;
		})();

		this.reconnectInFlight.set(serverId, reconnectPromise);
		try {
			return await reconnectPromise;
		} finally {
			this.reconnectInFlight.delete(serverId);
		}
	}

	private async executeWithAuthRecovery<T>(
		serverId: string,
		operation: (conn: ManagedConnection) => Promise<T>,
		options: { allowRecovery?: boolean } = {},
	): Promise<T> {
		const conn = this.connections.get(serverId);
		if (!conn) throw new Error(`Connection "${serverId}" not found.`);
		const allowRecovery = options.allowRecovery !== false;
		try {
			return await operation(conn);
		} catch (error) {
			if (
				!allowRecovery ||
				!conn.config.headerFactory ||
				!isAuthRecoveryError(error)
			) {
				throw error;
			}
			const recovered = await this.reconnect(serverId);
			return operation(recovered);
		}
	}

	async refreshConnection(
		serverId: string,
		options: { allowRecovery?: boolean } = {},
	): Promise<McpConnection> {
		return this.executeWithAuthRecovery(
			serverId,
			async (conn) => {
				if (conn.mode === "stateless") {
					return this.refreshStatelessConnection(serverId, conn);
				}
				const capabilities = conn.client.getServerCapabilities();

				// True atomic-replace: build every "next" snapshot off the side of
				// `conn`, await all listings, then swap them in as a single
				// synchronous block at the end. A reader on a different turn sees
				// either the full previous snapshot or the full new one — never
				// half a refresh (e.g. tools updated but resources still stale, or
				// templates briefly missing while skill-index merge is in flight).
				// ALWAYS attempt to list tools; on a transient error preserve the
				// existing tools rather than downgrading to `[]`. We deliberately do
				// NOT gate on `capabilities?.tools`: `getServerCapabilities()` can
				// momentarily return `undefined` (e.g. right after a mid-conversation
				// reconnect / AIH re-auth, before the fresh `initialize` lands), and
				// the old truthiness gate would then swap in `[]` and STRIP the
				// server's tools — including the Code Mode `code` tool — so
				// `selectCodeServer` throws "No connected MCP server exposes Code
				// Mode" for the rest of the session even though apps/mcp keeps
				// serving Code Mode. A genuinely tool-less server simply returns `[]`.
				const nextToolsPromise = conn.client
					.listTools(undefined, { cacheMode: "refresh" })
					.then((result) => mapToolsListResult(serverId, result))
					.catch(() => conn.tools);

				const nextResourcesPromise = capabilities?.resources
					? conn.client
							.listResources()
							.then((result) => mapResourcesListResult(serverId, result))
					: Promise.resolve<McpResourceInfo[]>([]);

				const nextResourceTemplatesPromise = capabilities?.resources
					? conn.client
							.listResourceTemplates()
							.then((result) =>
								mapResourceTemplatesListResult(serverId, result),
							)
							.catch(() => [])
					: Promise.resolve<McpResourceTemplateInfo[]>([]);

				const nextPromptsPromise = capabilities?.prompts
					? conn.client
							.listPrompts()
							.then((result) => mapPromptsListResult(serverId, result))
					: Promise.resolve<McpPromptInfo[]>([]);

				const [nextTools, nextResources, nextResourceTemplates, nextPrompts] =
					await Promise.all([
						nextToolsPromise,
						nextResourcesPromise,
						nextResourceTemplatesPromise,
						nextPromptsPromise,
					]);

				if (capabilities?.resources) {
					// SEP-2640 index-first skill discovery — operates on local
					// arrays so the merge doesn't briefly reveal a partial state.
					await this.mergeSkillIndex(conn, serverId, nextResources);
				}

				// Atomic swap. From this point a concurrent reader sees the new
				// snapshot consistently across all four slots.
				conn.tools = nextTools;
				conn.resources = nextResources;
				conn.resourceTemplates = nextResourceTemplates;
				conn.prompts = nextPrompts;

				conn.guidance = buildGuidanceResourceSummaries(
					conn,
					this.disabledSkills,
					this.guidanceSummaryMaxChars,
				);
				return conn.info;
			},
			options,
		);
	}

	listTools(serverId?: string): McpToolInfo[] {
		if (serverId) {
			const conn = this.connections.get(serverId);
			if (!conn) throw new Error(`Connection "${serverId}" not found.`);
			return conn.tools;
		}
		return [...this.connections.values()].flatMap(
			(connection) => connection.tools,
		);
	}

	async callTool(
		serverId: string,
		toolName: string,
		args?: Record<string, unknown>,
		options?: {
			signal?: AbortSignal;
			embeddedSessionToken?: string;
			onTaskInputRequired?: McpServerConfig["onTaskInputRequired"] | null;
		},
	): Promise<unknown> {
		const original = this.connections.get(serverId);
		if (!original) throw new Error(`Connection "${serverId}" not found.`);
		const signal = options?.signal;
		signal?.throwIfAborted();
		const originalResolver =
			options && Object.hasOwn(options, "onTaskInputRequired")
				? (options.onTaskInputRequired ?? createAgentElicitationResolver({}))
				: createAgentElicitationResolver({});
		const resolver: McpServerConfig["onTaskInputRequired"] = async (input) => {
			signal?.throwIfAborted();
			const result = await originalResolver(input);
			signal?.throwIfAborted();
			return result;
		};
		const bindInvocation = (
			connection: ManagedConnection,
		): ManagedConnection => ({
			...connection,
			config: { ...connection.config, onTaskInputRequired: resolver },
			get tools() {
				return connection.tools;
			},
			set tools(value) {
				connection.tools = value;
			},
		});
		const conn = bindInvocation(original);
		// Private proof belongs to this request only, never shared connection state.
		if (options?.embeddedSessionToken) {
			const result = await this.callToolWithSchemaRefresh(
				conn,
				toolName,
				args ?? {},
				options.embeddedSessionToken,
				signal,
			);
			return this.resolveTaskResult(conn.config, result, signal);
		}

		const retrySafe = this.isToolRetrySafe(conn, toolName);
		try {
			return await this.callToolOnConnectionWithAuthResultCheck(
				conn,
				toolName,
				args,
				signal,
			);
		} catch (firstError) {
			signal?.throwIfAborted();
			if (!this.shouldRecoverToolCall(firstError, retrySafe)) {
				throw firstError;
			}

			let recovered = conn;
			try {
				recovered = bindInvocation(await this.reconnect(serverId, signal));
			} catch (reconnectError) {
				signal?.throwIfAborted();
				if (!this.shouldRecoverToolCall(reconnectError, retrySafe)) {
					throw firstError;
				}
			}

			try {
				return await this.callToolOnConnectionWithAuthResultCheck(
					recovered,
					toolName,
					args,
					signal,
				);
			} catch (secondError) {
				signal?.throwIfAborted();
				if (!this.shouldRecoverToolCall(secondError, retrySafe)) {
					throw secondError;
				}
			}

			try {
				return this.assertNoAuthRecoveryResult(
					await this.callToolWithFreshClient(recovered, toolName, args, signal),
					toolName,
				);
			} catch (thirdError) {
				signal?.throwIfAborted();
				if (!this.shouldRecoverToolCall(thirdError, retrySafe)) {
					throw thirdError;
				}
			}

			return this.callToolWithStatelessPost(recovered, toolName, args, signal);
		}
	}

	private shouldRecoverToolCall(error: unknown, retrySafe: boolean): boolean {
		if (isAuthRecoveryError(error)) return true;
		return retrySafe && isTransportRecoveryError(error);
	}

	private isToolRetrySafe(conn: ManagedConnection, toolName: string): boolean {
		const toolInfo = conn.tools.find((tool) => tool.name === toolName);
		const annotations = toolInfo?.annotations;
		if (!annotations || annotations.destructiveHint) return false;
		return Boolean(annotations.readOnlyHint || annotations.idempotentHint);
	}

	/** Read a persisted MCP Task without replaying the originating tool call. */
	async getTask(serverId: string, taskId: string): Promise<McpTaskState> {
		return this.tasks.getTask(serverId, taskId);
	}

	/**
	 * Resume polling a task id persisted by the host across reloads or reconnects.
	 * Uses the same bounded polling and MRTR input resolver as a new tool call.
	 */
	async resumeTask(
		serverId: string,
		taskId: string,
		options?: {
			signal?: AbortSignal;
			onTaskInputRequired?: McpServerConfig["onTaskInputRequired"] | null;
		},
	): Promise<unknown> {
		return this.tasks.resumeTask(serverId, taskId, options);
	}

	/** Submit MRTR input responses for a persisted task. */
	async updateTask(
		serverId: string,
		taskId: string,
		inputResponses: Record<string, unknown>,
	): Promise<void> {
		return this.tasks.updateTask(serverId, taskId, inputResponses);
	}

	/** Cancel a persisted task explicitly. Unlike abort cleanup, errors surface. */
	async cancelTask(serverId: string, taskId: string): Promise<void> {
		return this.tasks.cancelTask(serverId, taskId);
	}

	private taskServerConfig(serverId: string): McpServerConfig {
		const conn = this.connections.get(serverId);
		if (!conn) throw new Error(`Connection "${serverId}" not found.`);
		return conn.config;
	}

	private async callToolOnConnectionWithAuthResultCheck(
		conn: ManagedConnection,
		toolName: string,
		args?: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<unknown> {
		const result = await this.callToolOnConnection(
			conn,
			toolName,
			args,
			signal,
		);
		return this.assertNoAuthRecoveryResult(result, toolName);
	}

	private assertNoAuthRecoveryResult(
		result: unknown,
		toolName: string,
	): unknown {
		const message = authRecoveryMessageFromResult(result);
		if (!message) return result;
		throw new Error(
			`MCP tool "${toolName}" returned recoverable auth result: ${message}`,
		);
	}

	private async callToolOnConnection(
		conn: ManagedConnection,
		toolName: string,
		args?: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<unknown> {
		const callArgs = args ?? {};
		const toolInfo = conn.tools.find((tool) => tool.name === toolName);
		const paramHeaders = buildMcpParamHeaders(toolInfo?.inputSchema, callArgs);
		if (conn.mode === "stateless" || Object.keys(paramHeaders).length > 0) {
			const result = await this.callToolWithSchemaRefresh(
				conn,
				toolName,
				callArgs,
				undefined,
				signal,
			);
			return this.resolveTaskResult(conn.config, result, signal);
		}
		const trace = this.outboundTraceContext();
		let result;
		try {
			result = await conn.client.callTool(
				{
					name: toolName,
					arguments: args,
					...(Object.keys(trace.meta).length > 0 ? { _meta: trace.meta } : {}),
				},
				{ signal },
			);
		} catch (error) {
			// Validation happens AFTER dispatch. Refresh metadata for the next call,
			// but preserve this failure: replay could duplicate a completed action.
			if (
				ProtocolError.isInstance(error) &&
				error.code === ProtocolErrorCode.InvalidParams &&
				error.message.includes(
					"Structured content does not match the tool's output schema:",
				)
			) {
				await this.refreshConnection(conn.info.serverId, {
					allowRecovery: false,
				}).catch((refreshError) => {
					console.error(
						"[mcp-client-core] tool schema refresh failed:",
						refreshError instanceof Error
							? refreshError.message
							: String(refreshError),
					);
				});
			}
			throw error;
		}
		return this.resolveTaskResult(conn.config, result, signal);
	}

	/**
	 * MCP 2026-07-28 Tasks (client side). If a tool result is a
	 * `resultType: "task"` envelope, drive it through the shared
	 * `@tedix/mcp-shared/task-polling` policy (backoff, not-found, abort →
	 * `tasks/cancel`, `input_required` via `onTaskInputRequired`) and return the
	 * completed tool result; any other outcome surfaces the task state.
	 */
	private async resolveTaskResult(
		config: McpServerConfig,
		result: unknown,
		signal?: AbortSignal,
	): Promise<unknown> {
		return this.tasks.resolveTaskResult(config, result, signal);
	}

	private async callToolWithFreshClient(
		conn: ManagedConnection,
		toolName: string,
		args?: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<unknown> {
		const fresh = await this.openConnection(
			conn.info.serverId,
			conn.config,
			priorDiscoveryFromConnection(conn),
			signal,
		);
		fresh.tools = conn.tools;
		try {
			return await this.callToolOnConnection(fresh, toolName, args, signal);
		} finally {
			await this.closeConnection(fresh).catch(() => {});
		}
	}

	private async callToolWithStatelessPost(
		conn: ManagedConnection,
		toolName: string,
		args?: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<unknown> {
		const callArgs = args ?? {};
		const result = await this.callToolWithSchemaRefresh(
			conn,
			toolName,
			callArgs,
			undefined,
			signal,
		);
		return this.resolveTaskResult(conn.config, result, signal);
	}

	/**
	 * MCP 2026-07-28 HeaderMismatch recovery. A `tools/call` rejected with
	 * -32020 has not executed. Refresh the authoritative tool schema, rebuild
	 * Mcp-Param-* bindings, and retry the original call exactly once.
	 */
	private async callToolWithSchemaRefresh(
		conn: ManagedConnection,
		toolName: string,
		callArgs: Record<string, unknown>,
		embeddedSessionToken?: string,
		signal?: AbortSignal,
	): Promise<unknown> {
		const call = (): Promise<unknown> => {
			const toolInfo = conn.tools.find((tool) => tool.name === toolName);
			return this.rawMcpPost(
				conn.config,
				"tools/call",
				{
					name: toolName,
					arguments: callArgs,
					...(embeddedSessionToken
						? { _meta: { "tedix/embedded-session": embeddedSessionToken } }
						: {}),
				},
				buildMcpParamHeaders(toolInfo?.inputSchema, callArgs),
				undefined,
				signal,
			);
		};

		try {
			return await call();
		} catch (error) {
			if (!isHeaderMismatchError(error)) throw error;
			const tools = await this.rawMcpListAll(
				conn.config,
				"tools/list",
				"tools",
			);
			conn.tools = mapToolsListResult(conn.info.serverId, tools);
			return call();
		}
	}

	listResources(serverId?: string): McpResourceInfo[] {
		if (serverId) {
			const conn = this.connections.get(serverId);
			if (!conn) throw new Error(`Connection "${serverId}" not found.`);
			return conn.resources;
		}
		return [...this.connections.values()].flatMap(
			(connection) => connection.resources,
		);
	}

	listResourceTemplates(serverId?: string): McpResourceTemplateInfo[] {
		if (serverId) {
			const conn = this.connections.get(serverId);
			if (!conn) throw new Error(`Connection "${serverId}" not found.`);
			return conn.resourceTemplates;
		}
		return [...this.connections.values()].flatMap(
			(connection) => connection.resourceTemplates,
		);
	}

	async readResource(serverId: string, uri: string): Promise<unknown> {
		return this.executeWithAuthRecovery(serverId, async (conn) =>
			this.readResourceOnConnection(conn, uri),
		);
	}

	/**
	 * Fetch the manifest for exactly one Skills-extension URI. This is an
	 * explicit, on-demand metadata read; it does not read the skill's resource
	 * contents or activate its instructions.
	 */
	async getSkill(serverId: string, uri: string): Promise<unknown> {
		const normalizedUri = uri.trim();
		if (!normalizedUri || normalizedUri !== uri || normalizedUri.length > 2_048)
			throw new Error(
				"uri must be a non-empty exact MCP skill URI (max 2048 characters)",
			);
		return this.executeWithAuthRecovery(serverId, async (conn) => {
			if (!connectionSupportsSkills(conn)) {
				throw new Error(
					`MCP skills/get unavailable: server "${serverId}" did not declare ${MCP_SKILLS_EXTENSION}`,
				);
			}
			const raw =
				conn.mode === "sdk"
					? await conn.client.request(
							{ method: "skills/get", params: { uri: normalizedUri } },
							GetSkillResultSchema,
						)
					: await this.rawMcpPost(conn.config, "skills/get", {
							uri: normalizedUri,
						});
			const parsed = GetSkillResultSchema.parse(raw);
			if (parsed.skill.uri !== normalizedUri)
				throw new Error(
					`MCP skills/get returned URI "${parsed.skill.uri}" for requested URI "${normalizedUri}"`,
				);
			const encoded = JSON.stringify(parsed);
			if (new TextEncoder().encode(encoded).byteLength > 1_048_576)
				throw new Error(
					"MCP skills/get response exceeds the 1 MiB metadata limit",
				);
			return parsed;
		});
	}

	/**
	 * Whether a connected server declared the skills extension's `directoryRead`
	 * capability (via `server/discover` for stateless connections, or the legacy
	 * `initialize` capabilities for SDK connections). A conformant client MUST
	 * NOT call `resources/directory/read` against a server that did not.
	 */
	serverSupportsDirectoryRead(serverId: string): boolean {
		const conn = this.connections.get(serverId);
		return conn ? connectionSupportsDirectoryRead(conn) : false;
	}

	async readDirectory(
		serverId: string,
		uri: string,
		cursor?: string,
	): Promise<unknown> {
		return this.executeWithAuthRecovery(serverId, async (conn) => {
			if (!connectionSupportsDirectoryRead(conn)) {
				// Undeclared capability: skip the round-trip and surface the same
				// method-not-found error a non-implementing server would return, so
				// callers take their existing directory-read failure path.
				throw new Error(
					`MCP resources/directory/read error: ${JSON.stringify({
						code: -32601,
						message:
							"Server did not declare the skills extension directoryRead capability",
					})}`,
				);
			}
			return this.rawMcpPost(conn.config, "resources/directory/read", {
				uri,
				...(cursor === undefined ? {} : { cursor }),
			});
		});
	}

	private async readResourceOnConnection(
		conn: ManagedConnection,
		uri: string,
	): Promise<unknown> {
		if (conn.mode === "stateless") {
			return this.rawMcpPost(conn.config, "resources/read", { uri });
		}
		try {
			return await conn.client.readResource({ uri });
		} catch {
			return this.rawMcpPost(conn.config, "resources/read", { uri });
		}
	}

	listPrompts(serverId?: string): McpPromptInfo[] {
		if (serverId) {
			const conn = this.connections.get(serverId);
			if (!conn) throw new Error(`Connection "${serverId}" not found.`);
			return conn.prompts;
		}
		return [...this.connections.values()].flatMap(
			(connection) => connection.prompts,
		);
	}

	async getPrompt(
		serverId: string,
		name: string,
		args?: Record<string, string>,
	): Promise<unknown> {
		return this.executeWithAuthRecovery(serverId, async (conn) => {
			if (conn.mode === "stateless") {
				return this.rawMcpPost(conn.config, "prompts/get", {
					name,
					...(args ? { arguments: args } : {}),
				});
			}
			try {
				return await conn.client.getPrompt({
					name,
					...(args ? { arguments: args } : {}),
				});
			} catch {
				return this.rawMcpPost(conn.config, "prompts/get", {
					name,
					...(args ? { arguments: args } : {}),
				});
			}
		});
	}

	/**
	 * Whether a connected server advertised the 2026-07-28 `completions`
	 * capability (via `server/discover` for stateless connections, or the SDK
	 * `initialize` capabilities for SDK connections). Lets a caller skip
	 * `complete()` on servers that cannot autocomplete.
	 */
	serverSupportsCompletions(serverId: string): boolean {
		const conn = this.connections.get(serverId);
		return Boolean(conn?.info.capabilities?.completions);
	}

	/**
	 * MCP 2026-07-28 autocomplete. Sends `completion/complete` to resolve
	 * suggestions for a prompt argument (`ref/prompt`) or a resource URI-template
	 * variable (`ref/resource`). Stateless connections always raw-POST so the
	 * modern binding headers + `_meta` are emitted; SDK connections try the live
	 * client first and fall back to raw POST on failure, same as
	 * `readResourceOnConnection`/`getPrompt`. Returns the server's
	 * `{ completion: { values, total?, hasMore? } }` result.
	 */
	async complete(
		serverId: string,
		ref: McpCompletionRef,
		argument: { name: string; value: string },
		context?: { arguments?: Record<string, string> },
	): Promise<McpCompletionResult> {
		return this.executeWithAuthRecovery(serverId, async (conn) => {
			const params = { ref, argument, ...(context ? { context } : {}) };
			const result =
				conn.mode === "stateless"
					? await this.rawMcpPost(conn.config, "completion/complete", params)
					: await conn.client
							.complete(params)
							.catch(() =>
								this.rawMcpPost(conn.config, "completion/complete", params),
							);
			const completion =
				isRecord(result) && isRecord(result.completion)
					? result.completion
					: {};
			const values = Array.isArray(completion.values)
				? completion.values.filter((v): v is string => typeof v === "string")
				: [];
			const out: McpCompletionResult = { values };
			if (typeof completion.total === "number") out.total = completion.total;
			if (typeof completion.hasMore === "boolean")
				out.hasMore = completion.hasMore;
			return out;
		});
	}

	listGuidanceResources(serverId?: string): McpGuidanceInfo[] {
		if (serverId) {
			const conn = this.connections.get(serverId);
			if (!conn) throw new Error(`Connection "${serverId}" not found.`);
			return conn.guidance;
		}
		return [...this.connections.values()].flatMap(
			(connection) => connection.guidance,
		);
	}

	async readGuidance(
		serverId: string,
		uri: string,
	): Promise<{ text: string; guidance: McpGuidanceInfo }> {
		return this.executeWithAuthRecovery(serverId, async (conn) => {
			const result = await this.readResourceOnConnection(conn, uri);
			return readGuidanceResult(
				conn,
				serverId,
				uri,
				result,
				this.guidanceMaxChars,
				this.guidanceSummaryMaxChars,
			);
		});
	}

	/** Merge native Skills extension discovery into the ordinary resource set. */
	private async mergeSkillIndex(
		conn: ManagedConnection,
		serverId: string,
		// Operate on caller-supplied "next" arrays so refreshConnection can
		// build the full snapshot off-side and swap atomically. Mutating
		// `conn.resources` directly here would briefly reveal a partial state.
		resources: McpResourceInfo[],
	): Promise<void> {
		if (!conn.extensions[MCP_SKILLS_EXTENSION]) return;
		try {
			const raw =
				conn.mode === "sdk"
					? await conn.client.request(
							{ method: "skills/list", params: {} },
							ListSkillsResultSchema,
						)
					: await this.rawMcpListAll(conn.config, "skills/list", "skills");
			const parsed = ListSkillsResultSchema.parse(raw);
			const known = new Map(
				resources.map((resource) => [resource.uri, resource]),
			);
			for (const entry of parsed.skills) {
				const audience = Array.isArray(entry.frontmatter.audience)
					? entry.frontmatter.audience.filter(
							(value): value is string => typeof value === "string",
						)
					: undefined;
				const existing = known.get(entry.uri);
				const projected: McpResourceInfo = {
					serverId,
					uri: entry.uri,
					name:
						typeof entry.frontmatter.name === "string"
							? entry.frontmatter.name
							: guidanceNameFromUri(entry.uri),
					description:
						typeof entry.frontmatter.description === "string"
							? entry.frontmatter.description
							: undefined,
					mimeType: "text/markdown",
					annotations: {
						...(existing?.annotations ?? {}),
						...(audience?.length ? { audience } : {}),
						...(entry.resources ? { resources: entry.resources } : {}),
					},
				};
				if (existing) Object.assign(existing, projected);
				else {
					resources.push(projected);
					known.set(entry.uri, projected);
				}
			}
		} catch {
			// A falsely advertised extension must not erase resources/list guidance.
		}
	}

	/** Unsolicited SDK requests have no invocation authority: deterministic form fill only. */
	private registerElicitationHandler(client: Client): void {
		client.setRequestHandler("elicitation/create", async (request) => {
			const resolve = createAgentElicitationResolver({});
			const params = request.params;
			if (params.mode === "url") return { action: "decline" as const };
			try {
				const responses = await resolve({
					taskId: "",
					inputRequests: {
						elicitation: {
							message: params.message,
							requestedSchema: params.requestedSchema,
						},
					},
				});
				const response = responses?.elicitation;
				return isRecord(response) && typeof response.action === "string"
					? (response as {
							action: "accept" | "decline" | "cancel";
							content?: Record<string, string | number | boolean | string[]>;
						})
					: { action: "decline" as const };
			} catch {
				return { action: "decline" as const };
			}
		});
	}
}
