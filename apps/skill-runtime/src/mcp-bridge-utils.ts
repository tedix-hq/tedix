import { WORKFLOW_PLATFORM_MCP_METHODS } from "@tedix/api-contract/utils/skill-manifest";
import {
	bindModernMcpRequest,
	MCP_TASKS_EXTENSION,
} from "@tedix/mcp-shared/protocol";

/**
 * Namespaces whose tools live on the aggregate server, not on a per-app
 * subdomain. The kernel/home surface is not an app, so `home.<host>` 404s with
 * "No app found for subdomain: home". `tedi` is the calling tedi's own tool
 * surface (artifact_read_file/artifact_write_file, cron, ...), exposed on the
 * aggregate under the namespace configured in `mcpConfig.aggregateTedis`.
 */
export const AGGREGATE_NAMESPACES = new Set(["home", "kernel", "tedi"]);

/**
 * The reserved `tedi` namespace is virtual: its tools are mounted inside the
 * organization's Code Mode aggregate under the calling tedi's configured
 * namespace. Unlike the first-class home/kernel tools, those aggregate-tedi
 * tools are not a reliable direct `tools/call` surface. Route them through the
 * aggregate's `code` tool from the outset so a workflow cannot spend its whole
 * step budget waiting for, or receive -32601 from, a direct prefixed call.
 */
export function requiresAggregateCodeMode(namespace: string): boolean {
	return namespace === "tedi";
}

/**
 * Extract the narrow task linkage returned by an accepted, still-pending tedi
 * turn. This is intentionally local to the skill-runtime bridge: MCP-native
 * Tasks use `resultType: "task"`, while aggregate Code Mode preserves the
 * tedi turn's application result (`{ pending, task: { id, pollWith } }`).
 *
 * Requiring the accepted/pending flags, the `tedi:` task namespace, and the
 * canonical polling method prevents arbitrary task-shaped tool output from
 * becoming an engine-controlled polling loop.
 */
export function extractPendingTediTaskId(result: unknown): string | null {
	if (!result || typeof result !== "object" || Array.isArray(result)) {
		return null;
	}
	const record = result as Record<string, unknown>;
	if (record.accepted !== true || record.pending !== true) return null;
	const task =
		record.task &&
		typeof record.task === "object" &&
		!Array.isArray(record.task)
			? (record.task as Record<string, unknown>)
			: null;
	if (
		!task ||
		typeof task.id !== "string" ||
		!task.id.startsWith("tedi:") ||
		task.pollWith !== "tasks/get"
	) {
		return null;
	}
	return task.id;
}

/** Resolve the namespace visible inside an aggregate Code Mode program. */
export function resolveCodeModeNamespace(
	namespace: string,
	tediNamespace?: string | null,
): string {
	if (namespace !== "tedi") return namespace;
	if (!tediNamespace) {
		throw new Error(
			"MCP_TARGET_UNRESOLVED: the `tedi` namespace needs the calling tedi's configured aggregate namespace",
		);
	}
	return tediNamespace;
}

export interface McpTarget {
	/** App/server slug used to build `https://<slug>.<mcpBaseHost>/mcp`. */
	slug: string;
	/** Wire tool name to send in `tools/call`. */
	toolName: string;
}

const CODE_MODE_IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

interface JsonRpcRequestBody {
	jsonrpc?: unknown;
	id?: unknown;
	method?: unknown;
	params?: unknown;
}

/**
 * Bind one loader-side JSON-RPC request to MCP 2026-07-28.
 *
 * Every target reached by the skill runtime goes through the first-party
 * apps/mcp service binding, so this bridge does not need per-origin legacy
 * negotiation. The workflow runtime polls MCP Tasks itself and therefore
 * declares that extension on every request. Existing workflow provenance in
 * `params._meta` is retained alongside the protocol-owned client metadata.
 */
export function buildModernMcpBridgeRequest(body: unknown): {
	body: Record<string, unknown>;
	headers: Record<string, string>;
} {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		throw new Error("MCP_REQUEST_INVALID: JSON-RPC body must be an object");
	}
	const request = body as JsonRpcRequestBody;
	if (typeof request.method !== "string" || request.method.length === 0) {
		throw new Error("MCP_REQUEST_INVALID: JSON-RPC method is required");
	}
	const params =
		request.params &&
		typeof request.params === "object" &&
		!Array.isArray(request.params)
			? (request.params as Record<string, unknown>)
			: {};
	const bound = bindModernMcpRequest(request.method, params, {
		clientName: "tedix-skill-runtime",
		clientCapabilities: {
			extensions: { [MCP_TASKS_EXTENSION]: {} },
		},
	});

	return {
		body: { ...(body as Record<string, unknown>), params: bound.params },
		headers: bound.headers,
	};
}

/**
 * Bind a tool call to the Work Item admitted with its durable workflow run.
 *
 * Tenant workflow code never controls this value: the host-side bridge applies
 * it after constructing the call envelope and overwrites any colliding key.
 * apps/mcp then forwards this request metadata only across its authenticated
 * service binding to the API.
 */
export function injectWorkflowWorkItemMeta(
	meta: Record<string, unknown>,
	workItemId: string | null | undefined,
): Record<string, unknown> {
	if (!workItemId) return meta;
	return {
		...meta,
		"io.tedix/workItemId": workItemId,
	};
}

const IDENTITY_BOUND_PLATFORM_TOOLS = new Set([
	...WORKFLOW_PLATFORM_MCP_METHODS.cognitive.map(
		(method) => `cognitive.${method}`,
	),
	"tedix.record_artifact",
]);

/**
 * Add engine-owned identity fields required by platform tools.
 *
 * The run's tedi identity comes from the admitted workflow snapshot, not from
 * tenant source or invocation params. The bridge applies this before both the
 * direct JSON-RPC call and Code Mode recovery so both routes share authority.
 */
export function injectWorkflowToolIdentity(
	namespace: string,
	method: string,
	args: unknown,
	tediId: string,
): unknown {
	if (!IDENTITY_BOUND_PLATFORM_TOOLS.has(`${namespace}.${method}`)) {
		return args ?? {};
	}
	if (args != null && (typeof args !== "object" || Array.isArray(args))) {
		throw new Error(
			`WORKFLOW_TOOL_ARGUMENTS_INVALID: ${namespace}.${method} requires an object argument`,
		);
	}
	return {
		...((args ?? {}) as Record<string, unknown>),
		tediId,
	};
}

/**
 * Build the aggregate Code Mode program used when an app exposes only its
 * `code` tool. Safe identifiers deliberately use dot notation: apps/mcp's
 * targeted provider hydration recognizes `namespace.method(...)` calls and
 * loads only those aggregate providers before executing the program. Keep a
 * quoted bracket fallback for legacy/non-identifier tool names; the hydrator
 * recognizes that static form as well.
 */
export function buildCodeModeCallSource(
	namespace: string,
	method: string,
	args: unknown,
): string {
	if (!CODE_MODE_IDENTIFIER_RE.test(namespace)) {
		throw new Error(
			`MCP_CODEMODE_NAMESPACE_INVALID: ${namespace} is not a safe Code Mode identifier`,
		);
	}
	const member = CODE_MODE_IDENTIFIER_RE.test(method)
		? `.${method}`
		: `[${JSON.stringify(method)}]`;
	return `async () => await ${namespace}${member}(${JSON.stringify(args ?? {})})`;
}

/**
 * A tenant proxy can declare a tenant-scoped credential overlay while its
 * source app retains a user-scoped tool config. Direct service-auth tool
 * registration may expose the source tool before the proxy overlay is applied,
 * yielding a structured credential miss instead of a JSON-RPC error. That miss
 * is safe to retry through the owning aggregate's Code Mode surface: credential
 * resolution failed before the provider action ran, and the aggregate applies
 * the host/proxy connection overlay during targeted hydration.
 */
export function needsAggregateCredentialRecovery(result: unknown): boolean {
	if (!result || typeof result !== "object") return false;
	const record = result as Record<string, unknown>;
	if (record.ok !== false) return false;
	const error = typeof record.error === "string" ? record.error : "";
	return /connection credential not found/i.test(error);
}

/**
 * Resolve the upstream MCP server slug + the wire tool name for a namespaced
 * skill call (`env.MCP.<namespace>.<method>`).
 *
 * Most namespaces map 1:1 to an app subdomain and use the bare tool name. The
 * kernel/home surface is not an app — its tools live on the org-wide aggregate
 * server under prefixed names (e.g. `ask`) — so route those there
 * instead of a nonexistent `home.<host>` subdomain. Reserved aggregate
 * namespaces (`home`/`kernel`) always resolve to the aggregate and can never be
 * shadowed by a mapped app slug; any other namespace that resolves to a real app
 * slug uses that app. A namespace with no app match at all (platform gateway
 * namespaces like `seo`/`cognitive`/`analytics`) also routes to the aggregate
 * under its prefixed wire name rather than a dead `<namespace>.<host>` subdomain.
 */
export function resolveMcpTarget(
	namespace: string,
	method: string,
	namespaceToSlug: Record<string, string>,
	aggregateMcpSlug: string,
	tediNamespace?: string | null,
): McpTarget {
	// SECURITY: reserved aggregate namespaces take precedence over any mapped app
	// slug. The namespace→slug lookup (resolveNamespaceSlugs) is an org-wide
	// `SELECT slug FROM apps` with no reserved-name guard, so without this an
	// attacker who creates an app slugged `home`/`kernel`/`tedi` in the org would
	// hijack those tool calls a skill makes (calls carry the caller's org/tedi
	// headers). An app slug must never shadow a reserved aggregate surface.
	if (namespace === "tedi") {
		if (!tediNamespace) {
			throw new Error(
				"MCP_TARGET_UNRESOLVED: the `tedi` namespace needs the calling tedi's configured aggregate namespace",
			);
		}
		return {
			slug: aggregateMcpSlug,
			toolName: `${tediNamespace}__${method}`,
		};
	}
	if (AGGREGATE_NAMESPACES.has(namespace)) {
		if (namespace === "home" && method === "ask") {
			return { slug: aggregateMcpSlug, toolName: "ask" };
		}
		return { slug: aggregateMcpSlug, toolName: `${namespace}__${method}` };
	}
	const mapped = namespaceToSlug[namespace];
	if (mapped) {
		return { slug: mapped, toolName: method };
	}
	// Unmapped namespace: resolveNamespaceSlugs found no app for it (exact,
	// `-tedix`, or dashed candidate), so `<namespace>.<host>` is a dead
	// subdomain ("No app found for subdomain"). Treat it as a gateway
	// namespace on the org-wide aggregate under the prefixed wire name —
	// the same surface shape as home/kernel (`seo__query_gsc_search_analytics`,
	// `cognitive__record_artifact`). Same trust boundary as any aggregate call:
	// the request carries the caller's org/tedi identity and the gateway's
	// scope/annotation gates decide, so no capability widening occurs here.
	return { slug: aggregateMcpSlug, toolName: `${namespace}__${method}` };
}

// `McpInputRequiredError` and the JSON-RPC/CallToolResult unwrap pipeline
// moved to `@tedix/mcp-shared/tool-result` — the shared normalization used by
// both this bridge and tedi-codemode-core, so a tool result can never take a
// different shape depending on which surface called it.

export function selectMcpToolNameFromList(
	method: string,
	toolsListResult: unknown,
): string | null {
	const tools =
		toolsListResult &&
		typeof toolsListResult === "object" &&
		Array.isArray((toolsListResult as { tools?: unknown }).tools)
			? (toolsListResult as { tools: unknown[] }).tools
			: [];
	const names = tools
		.map((tool) =>
			tool &&
			typeof tool === "object" &&
			typeof (tool as { name?: unknown }).name === "string"
				? (tool as { name: string }).name
				: null,
		)
		.filter((name): name is string => Boolean(name));

	if (names.includes(method)) return method;

	const suffix = `__${method}`;
	const prefixedMatches = names.filter((name) => name.endsWith(suffix));
	return prefixedMatches.length === 1 ? (prefixedMatches[0] ?? null) : null;
}
