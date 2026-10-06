import type { FetchFunction } from "@tedix/api-client/client";
import { callRpc, serviceBindingFetch } from "@tedix/api-client/internal";
import type { HttpPlatformClient } from "./brain/platform-client";
import { buildMcpDiscoveryCacheAnalyticsDataPoint } from "@tedix/api-contract/schemas/mcp-analytics";
import type { TediRuntimeEvent } from "@tedix/api-contract/schemas/cognitive-runtime";
import type { McpDiscoveryCacheEvent } from "@tedix/mcp-client-core/client-manager";
import {
	type AssignedMcpServer,
	type ResolvedMcpCredentials,
	TedixMcpRuntime,
	type TedixMcpRuntimeBinding,
} from "@tedix/mcp-client-core/runtime";
import type { McpGuidanceInfo } from "@tedix/mcp-client-core/types";
import type { ChatToolSpec } from "./llm";
import { McpToolResultStore } from "./mcp-tool-results";
import type { DurableCodeWorkspace } from "./durable-codemode";

/**
 * Cold-start guard: bound the credential-resolution fetches so a wedged/slow
 * apps/api or Descope leg cannot hang `ensureSynced()` (and therefore the
 * workflow's `prepare-context` step) indefinitely — the cold-tedi turn-START
 * stall (`run.started` with no first model step). A REAL `AbortSignal` (not a
 * bare `Promise.race`) so the underlying socket actually cancels, mirroring the
 * AbortController pattern the runtime already uses for the Azure calls. 10s is
 * well above a healthy `listServers`/`resolve` and safely under the 30s MCP edge
 * wall. On timeout the fetch throws → `getMcpRuntime`'s catch caches the runtime
 * un-synced and the turn proceeds (tools self-heal on the next access).
 */
const MCP_CREDENTIAL_FETCH_TIMEOUT_MS = 10_000;

/**
 * Interactive MCP calls can cross the aggregate gateway, credential resolver,
 * and a tenant proxy before reaching the provider. Production widget telemetry
 * has observed healthy calls complete just beyond 20 seconds, so the previous
 * 15/20-second cutoffs converted slow successes into visible tool failures.
 * Keep these below the durable turn wall and never retry a call automatically:
 * the selected callable may be write-capable.
 */
export const INTERACTIVE_MCP_TOOL_TIMEOUTS = {
	tedix_mcp_code: 45_000,
	tedix_mcp_call_tool: 30_000,
	tedix_mcp_list_namespaces: 30_000,
	tedix_mcp_search_tools: 30_000,
} as const;

export function writeDiscoveryCacheMetric(
	dataset: Pick<AnalyticsEngineDataset, "writeDataPoint"> | undefined,
	event: McpDiscoveryCacheEvent,
	identity: { organizationId?: string; tediId: string },
): void {
	try {
		dataset?.writeDataPoint(
			buildMcpDiscoveryCacheAnalyticsDataPoint({
				...event,
				organizationId: identity.organizationId,
				tediId: identity.tediId,
			}),
		);
	} catch {
		// Cache observability is best-effort and cannot break MCP sync.
	}
}

export async function callMcpCredentialApi<T>(input: {
	apiUrl: string;
	path: "mcpCredentials/listServers" | "mcpCredentials/resolve";
	tediId: string;
	organizationId?: string;
	body: unknown;
	fetch: FetchFunction;
	signal?: AbortSignal;
}): Promise<T> {
	// Per-leg latency probe (non-behavioral): the two credential legs
	// (listServers + resolve) are sequential apps/api service-binding calls on the
	// cold connect path, the suspected leg that tips an idle-tedi connect past the
	// 10s connectTimeoutMs. One structured line lets `wrangler tail` attribute the
	// cold-connect wall clock to credential resolve vs the gateway list phase.
	const t0 = performance.now();
	let ok = true;
	try {
		return await callRpc<T>(input.path, input.body, {
			apiUrl: input.apiUrl,
			fetch: input.fetch,
			headers: {
				"Accept-Encoding": "identity",
				"X-Service-Binding": "true",
				"X-Tedix-Tedi-Id": input.tediId,
				...(input.organizationId
					? { "X-Tedix-Organization-Id": input.organizationId }
					: {}),
			},
			signal: input.signal,
		});
	} catch (err) {
		ok = false;
		throw err;
	} finally {
		console.log(
			`[mcp-cred-timing] ${input.path} ms=${Math.round(performance.now() - t0)} ok=${ok} tedi=${input.tediId.slice(0, 8)}`,
		);
	}
}

export interface AgentToolEventBinding extends TedixMcpRuntimeBinding {
	platform: HttpPlatformClient;
}

export function mcpCredentialResolveInput(
	tediId: string,
	serverUrl: string,
	delegatedTurn?: { runId: string; homeRunId: string; workItemId: string },
): {
	tediId: string;
	serverUrl: string;
	delegatedTurn?: { runId: string; homeRunId: string; workItemId: string };
} {
	return {
		tediId,
		serverUrl,
		...(delegatedTurn ? { delegatedTurn } : {}),
	};
}

export function toTediToolRuntimeEvent(
	event: Parameters<
		NonNullable<
			import("@tedix/mcp-client-core/runtime").TedixMcpRuntimePlatform["recordToolEvent"]
		>
	>[0],
	tediId: string,
	createdAt = new Date().toISOString(),
): TediRuntimeEvent {
	return {
		id: `${event.runId}:${event.idSuffix}`,
		tediId,
		kind: event.kind,
		conversationId: event.conversationId,
		runId: event.runId,
		sequence: event.sequence,
		payload: event.payload,
		runtime: { backend: "cloudflare-agents" },
		createdAt,
	};
}

/**
 * Build the rejection used when a per-turn abort signal trips during a tool
 * dispatch race. Prefers the signal's own `reason` (the dispatcher passes a
 * descriptive Error/DOMException), falling back to a generic AbortError.
 */
function signalAbortError(signal: AbortSignal, fallback: string): Error {
	if (signal.reason instanceof Error) return signal.reason;
	return new DOMException(fallback, "AbortError");
}

/**
 * Thin Cloudflare-DO adapter around @tedix/mcp-client-core.
 *
 * The core package owns MCP assignment sync, credential resolution, Code Mode
 * wrappers, result parsing, per-tool timeout policy, and tool event sequencing.
 * This adapter only supplies Tedix API auth and maps core tool events into the
 * isolate tedi cognitive-runtime ledger.
 */
export class AgentMcpRuntime {
	private turnPlatform: HttpPlatformClient | null = null;
	private readonly core: TedixMcpRuntime;
	private readonly resultStores = new Map<string, McpToolResultStore>();

	constructor(
		private readonly env: Cloudflare.Env,
		private readonly tediId: string,
		private readonly orgId?: string,
		/**
		 * Durable-first publication seam for tool ledger rows. The DO passes its
		 * `RuntimeEventOutbox.publish`, which persists the event locally and
		 * writes it to the API in the background — `tool.started` and
		 * `tool.completed` bracket every tool call, so awaiting a ~1s ledger RPC
		 * twice per call sat directly on the answer's critical path. Absent (tests
		 * / non-DO hosts), the event is written straight through as before.
		 */
		private readonly publishRuntimeEvent?: (
			event: TediRuntimeEvent,
		) => Promise<void>,
		private readonly resultWorkspace?: (
			conversationId: string,
		) => DurableCodeWorkspace,
		private readonly delegatedTurn?: {
			runId: string;
			homeRunId: string;
			workItemId: string;
		},
	) {
		this.core = new TedixMcpRuntime({
			onDiscoveryCacheEvent: (event) =>
				writeDiscoveryCacheMetric(this.env.RUNTIME_ANALYTICS, event, {
					organizationId: this.orgId,
					tediId: this.tediId,
				}),
			platform: {
				listServers: () => this.fetchAssignedServers(),
				resolveCredentials: (serverUrl) =>
					this.resolveConnectionCredentials(serverUrl),
				recordToolEvent: async (event) => {
					const platform = this.turnPlatform;
					if (!platform) return;
					const runtimeEvent = toTediToolRuntimeEvent(event, this.tediId);
					if (this.publishRuntimeEvent) {
						await this.publishRuntimeEvent(runtimeEvent);
						return;
					}
					await platform.recordRuntimeEvent(runtimeEvent);
				},
			},
			retainToolResult: this.resultWorkspace
				? async ({ binding, result }) =>
						await this.resultStore(binding.conversationId).retain(result)
				: undefined,
			// The official SDK negotiates modern sessionless HTTP. Code Mode only
			// needs tools; optional guidance must not gate connection readiness.
			deferOptionalDiscovery: true,
			connectTimeoutMs: 10_000,
			toolTimeoutMs: INTERACTIVE_MCP_TOOL_TIMEOUTS,
			// No accepted-origin model is wired: elicitation stays deterministic.
			logger: console,
		});
	}

	private resultStore(conversationId: string): McpToolResultStore {
		while (this.resultStores.size >= 32) {
			const idle = [...this.resultStores].find(
				([key, store]) => key !== conversationId && store.isIdle,
			);
			if (!idle) break;
			this.resultStores.delete(idle[0]);
		}
		const existing = this.resultStores.get(conversationId);
		if (existing) return existing;
		if (!this.resultWorkspace)
			throw new Error("MCP result retention is unavailable");
		const store = new McpToolResultStore(this.resultWorkspace(conversationId));
		this.resultStores.set(conversationId, store);
		return store;
	}

	async readRetainedResult(
		binding: TedixMcpRuntimeBinding,
		input: {
			resultId: string;
			offset?: number;
			limit?: number;
			query?: string;
		},
	): Promise<unknown> {
		return await this.resultStore(binding.conversationId).read(input);
	}

	getToolCallLog() {
		return this.core.getToolCallLog();
	}

	bindTurn(binding: AgentToolEventBinding): void {
		this.turnPlatform = binding.platform;
		this.core.bindTurn({
			conversationId: binding.conversationId,
			runId: binding.runId,
			traceId: binding.traceId ?? binding.runId,
			tracestate: binding.tracestate,
			toolArgumentConstraints: binding.toolArgumentConstraints,
			toolNamespacePrefix: binding.toolNamespacePrefix,
		});
	}

	clearTurn(): void {
		// Deliberately does NOT null `turnPlatform`. The platform client is a stable
		// per-DO singleton and this runtime instance is SHARED across concurrent
		// turns, so nulling it here let a FINISHING sibling turn drop an in-flight
		// turn's tool events (the direct-path telemetry gap). Tool events now carry
		// their own per-call binding (see `executeTool`), so a retained platform
		// reference is always the right sink. `bindTurn` overwrites it each turn
		// with the same instance; it is only truly released on DO reset, which
		// discards the whole runtime.
		this.core.clearTurn();
	}

	getToolSpecs(): ChatToolSpec[] {
		return this.core.getToolSpecs() as ChatToolSpec[];
	}

	async refreshCredentialBoundToolInventory(): Promise<
		Array<{
			serverId: string;
			serverUrl: string;
			name: string;
		}>
	> {
		await this.core.ensureSynced({ force: true });
		const urls = new Map(
			this.core
				.getManager()
				.listConnections()
				.map((connection) => [connection.serverId, connection.url]),
		);
		return this.core
			.getManager()
			.listTools()
			.map((tool) => ({
				serverId: tool.serverId,
				serverUrl: urls.get(tool.serverId) ?? "",
				name: tool.name,
			}));
	}

	async refreshConnections(): Promise<void> {
		await this.core.ensureSynced({ force: true });
	}

	async discoverCredentialBoundReviewCallables(): Promise<string[]> {
		return this.core.discoverCredentialBoundReviewCallables();
	}

	getSystemInstructions(options: { includeGuidance?: boolean } = {}): string {
		const base = this.core.getSystemInstructions();
		if (options.includeGuidance === false) return base;
		const guidance = this.getGuidanceContext();
		return guidance ? `${base}\n\n${guidance}` : base;
	}

	/** Base Code Mode contract without per-server skill and policy summaries. */
	getUtilitySystemInstructions(): string {
		return this.getSystemInstructions({ includeGuidance: false });
	}

	/**
	 * Per-turn MCP guidance block (skill/guide/policy summaries) for progressive
	 * disclosure, mirroring the container plugin's before_prompt_build context.
	 * Already folded into {@link getSystemInstructions}; exposed separately for
	 * callers that assemble the system prompt out of band.
	 *
	 * Skills ride in this block on EVERY isolate turn path (as `- skill {name}:
	 * {summary} ...` lines), with the full `skill://` body read on demand via
	 * `mcp_read_resource`. The Cloudflare Agents SDK skills engine is not used —
	 * see do.ts (the removed `getSkills()` override note).
	 */
	getGuidanceContext(): string | undefined {
		return this.core.buildGuidanceContext();
	}

	listGuidanceResources(): McpGuidanceInfo[] {
		return this.core.listGuidanceResources();
	}

	async readGuidance(
		serverId: string,
		uri: string,
	): Promise<{ text: string; guidance: McpGuidanceInfo }> {
		return this.core.readGuidance(serverId, uri);
	}

	async readResource(serverId: string, uri: string): Promise<unknown> {
		return this.core.readResource(serverId, uri);
	}

	async readDirectory(
		serverId: string,
		uri: string,
		cursor?: string,
	): Promise<unknown> {
		return this.core.readDirectory(serverId, uri, cursor);
	}

	async ensureSynced(options: { force?: boolean } = {}): Promise<void> {
		if (!this.tediId) throw new Error("Missing tediId for MCP runtime");
		if (!this.env.API_URL) throw new Error("API_URL missing from Worker env");
		if (!this.env.API_SERVICE) {
			throw new Error("API_SERVICE missing from Worker env");
		}
		await this.core.ensureSynced(options);
	}

	async executeTool(
		name: string,
		args: Record<string, unknown>,
		opts?: { signal?: AbortSignal; binding?: TedixMcpRuntimeBinding | null },
	): Promise<unknown> {
		const signal = opts?.signal;
		// Thread the CALLING turn's binding into core so its tool events survive a
		// concurrent turn's bindTurn/clearTurn on this shared instance (see
		// core.executeTool + clearTurn notes). Explicit null/undefined cannot
		// borrow a sibling binding; omitted options use the captured shared turn.
		const coreOpts =
			opts && Object.hasOwn(opts, "binding")
				? { binding: opts.binding ?? null }
				: undefined;
		if (!signal) {
			return await this.core.executeTool(name, args, coreOpts);
		}
		if (signal.aborted) {
			throw signalAbortError(signal, "tool call aborted before dispatch");
		}
		// The signal is threaded INTO core (cost protection): core's
		// task-polling loop observes it, fires a best-effort `tasks/cancel` for a
		// still-running upstream Task, and rejects — so an aborted turn actually
		// stops the upstream work instead of only abandoning the promise locally.
		// The race below is kept as a promptness backstop for the signal-unaware
		// legs (in-flight SDK/stateless POSTs), which stay bounded by core's
		// per-tool timeout. The dispatch sites pass a fresh composite
		// (`AbortSignal.any`) per call, so the abort listener is GC'd with that
		// throwaway signal. Additive: a never-aborted signal just adds an inert
		// reject path that never fires.
		let onAbort: (() => void) | null = null;
		const abortPromise = new Promise<never>((_, reject) => {
			onAbort = () => reject(signalAbortError(signal, "tool call aborted"));
			signal.addEventListener("abort", onAbort, { once: true });
		});
		const corePromise = this.core.executeTool(name, args, {
			...coreOpts,
			signal,
		});
		// When the abort backstop wins the race, the signal-aware core promise
		// still settles shortly after (rejecting with the same abort once its
		// best-effort `tasks/cancel` lands). Mark that late rejection handled so
		// it never surfaces as an unhandled rejection.
		corePromise.catch(() => {});
		try {
			return await Promise.race([corePromise, abortPromise]);
		} finally {
			if (onAbort) signal.removeEventListener("abort", onAbort);
		}
	}

	private async fetchAssignedServers(): Promise<AssignedMcpServer[]> {
		const data = await callMcpCredentialApi<{
			servers?: Array<{ serverId: string; url: string; transport?: string }>;
		}>({
			apiUrl: this.env.API_URL,
			path: "mcpCredentials/listServers",
			tediId: this.tediId,
			organizationId: this.orgId,
			body: { tediId: this.tediId },
			fetch: serviceBindingFetch(this.env.API_SERVICE),
			signal: AbortSignal.timeout(MCP_CREDENTIAL_FETCH_TIMEOUT_MS),
		});
		return (data.servers ?? []).map((server) => ({
			serverId: server.serverId,
			url: server.url,
			transport: "streamable-http",
		}));
	}

	private async resolveConnectionCredentials(
		serverUrl: string,
	): Promise<ResolvedMcpCredentials> {
		return callMcpCredentialApi<ResolvedMcpCredentials>({
			apiUrl: this.env.API_URL,
			path: "mcpCredentials/resolve",
			tediId: this.tediId,
			organizationId: this.orgId,
			body: mcpCredentialResolveInput(
				this.tediId,
				serverUrl,
				this.delegatedTurn,
			),
			fetch: serviceBindingFetch(this.env.API_SERVICE),
			signal: AbortSignal.timeout(MCP_CREDENTIAL_FETCH_TIMEOUT_MS),
		});
	}
}
