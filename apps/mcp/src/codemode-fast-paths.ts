import { sidebarAppConfig, sidebarAppToolMeta } from "./mcp/sidebar-app";
import { ATTENTION_GUIDANCE } from "./mcp/attention-guidance";
import {
	capServerInstructions,
	codeModeInstructionParts,
} from "./mcp/codemode-guidance";
import { clientSupportsMcpApps } from "./mcp/client-apps-capability";
import { resolveToolWidgetRoute } from "./mcp/utils/render-widget";
import { isCodeModeNativeOptIn } from "./mcp/code-mode-native-tools";
import { z } from "zod";
import { extractCodeModeProviderNamespacesFromCode } from "./mcp/code-mode-namespaces";
import { parseMcpCallerFromHeaders } from "./mcp-result-transform";
import { codeModeInputSchema } from "./mcp/connect-payment-policy";
import { isConfiguredCatalogTool } from "./mcp/registration/bootstrap";
import { resolveToolAnnotations } from "@tedix/api-contract/schemas/tools";
import { isDelegatedWorkTool } from "@tedix/auth/delegated-mcp-token";
import { CODE_MODE_TOOL_ANNOTATIONS } from "@tedix/mcp-shared/codemode";
import {
	MCP_MODERN_PROTOCOL_VERSION,
	MCP_PROTOCOL_VERSION_HEADER,
	MCP_TASKS_EXTENSION,
} from "@tedix/mcp-shared/protocol";
import {
	DEFAULT_MCP_CACHE_HINT,
	MCP_SUPPORTED_PROTOCOL_VERSIONS,
} from "@tedix/mcp-shared/transport";
import {
	codeModeSecurityMeta,
	codeModeToolMeta,
} from "./mcp/codemode-security";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import {
	isMcpToolVisibleToCaller,
	resolveMcpToolNamespace,
	resolveMcpToolRequiredScopes,
} from "@tedix/mcp-shared/auth/tool-scopes";
import { shouldExposeHomeSurface } from "./mcp/home-surface";
import {
	accountProfileEnabled,
	accountProfileResult,
	accountProfileTool,
} from "./mcp/registration/account-profile";
import { extractCallerIdentity } from "./mcp/server-factory";
import { sortToolsDeterministically } from "./mcp/tools-list-order";
import { paginateSortedToolsList } from "./mcp/tools-list-pagination";
import type { ResolvedApp } from "./resolution";
import {
	decorateModernFastPathResult,
	jsonRpcEnvelopeErrorResponse,
	jsonRpcEnvelopeResponse,
	readJsonRpcBody,
	readJsonRpcEnvelope,
	requestBodyTooLargeResponse,
	validateModernFastPathRequest,
} from "./json-rpc-envelope";
import {
	MCP_EVENTS_EXTENSION,
	type McpSubscriptionBindingEnv,
} from "./mcp-events-routes";

/**
 * Code Mode fast paths the Worker answers before building a server: the
 * bootstrap tool call, the compact two-tool `tools/list` and `server/discover`
 * surface, and the request readers that pick Code Mode namespaces.
 */

export async function extractRequestedCodeModeNamespaces(
	request: Request,
): Promise<Set<string> | null> {
	const body = await readJsonRpcBody(request);
	if (body?.method !== "tools/call") return null;
	const params = isRecord(body.params) ? body.params : {};
	if (params.name !== "code") return null;
	const args = isRecord(params.arguments) ? params.arguments : {};
	const code = typeof args.code === "string" ? args.code : "";
	if (!code) return new Set();
	return extractCodeModeProviderNamespacesFromCode(code);
}

export async function extractDirectToolCallArguments(
	request: Request,
): Promise<Record<string, unknown>> {
	const body = await readJsonRpcBody(request);
	const params = isRecord(body?.params) ? body.params : {};
	return isRecord(params.arguments) ? params.arguments : {};
}

export async function maybeHandleBootstrapFastMcp(
	request: Request,
	resolvedApp: ResolvedApp,
): Promise<Response | null> {
	if (request.method !== "POST") return null;
	const envelope = await readJsonRpcEnvelope(request);
	if (envelope && "tooLarge" in envelope) return requestBodyTooLargeResponse();
	if (!envelope) return null;
	const modernError = validateModernFastPathRequest(request, envelope);
	if (modernError) return modernError;
	const body = envelope.body;
	if (body?.method !== "tools/call") return null;
	const params = isRecord(body.params) ? body.params : {};
	if (
		params.name === "get_profile" &&
		accountProfileEnabled(resolvedApp.metadata?.mcpConfig)
	) {
		return jsonRpcEnvelopeResponse(
			envelope,
			decorateModernFastPathResult(envelope, resolvedApp, {
				resultType: "complete",
				...accountProfileResult(
					extractCallerIdentity(request),
					params.arguments ?? {},
				),
			}),
		);
	}
	// get_info needs the same full authenticated registry as session bootstrap.
	// Its no-loader response is built after selected-org routing and hydration.
	return null;
}

function compactCodeModeToolDescription(resolvedApp: ResolvedApp): string {
	const appSlug = resolvedApp.app.slug;
	return [
		`Execute JavaScript against the ${appSlug} Code Mode surface.`,
		'Find tools and skills with bounded discovery, for example `async () => await discover.search({"query":"list_mcp_authorizations","limit":3})`; this loads the aggregate catalog. Use each returned tool callable exactly, including its namespace prefix; follow the returned load expression for skills. Once the namespace is known, a single JSON-literal search with that exact `namespace` value or an exact `async () => await discover.describe("namespace.tool")` expression loads only that namespace.',
		"Call `codemode.__runtime()` for execution-surface proof.",
		ATTENTION_GUIDANCE,
	].join(" ");
}

export function modernDiscoverInstructions(
	resolvedApp: ResolvedApp,
	connectionAppSlug: string,
): string | undefined {
	const mcpConfig = resolvedApp.metadata?.mcpConfig;
	const configured =
		typeof mcpConfig?.serverInstructions === "string"
			? mcpConfig.serverInstructions.trim()
			: "";
	const codeMode =
		mcpConfig?.codeMode === true
			? [
					[
						"Use Code Mode for broad Tedix operations.",
						"Long-running work may return task handles; poll tasks/get and provide requested input through tasks/update.",
						"For operator-to-tedi validation, prefer the governed Home/kernel path or direct tedi namespace run_tedi_turn/messages_read when explicitly requested.",
					].join(" "),
					...codeModeInstructionParts(connectionAppSlug),
				]
			: [];
	// Platform guidance first: the cap trims tenant text, not Code Mode rules.
	return capServerInstructions(
		[...codeMode, configured],
		"see the code tool description",
	).instructions;
}

// Exported for the outer-surface lane conformance test: the stateless fast
// path advertises `code` (plus configured catalog rows and explicit
// `codeModeNativeTools` opt-ins) and never `ask` — see
// outer-surface-lanes.test.ts and docs/engineering/mcp/codemode.md.
export function compactCodeModeTools(
	resolvedApp: ResolvedApp,
	requestHeaders: Headers,
	connectionAppSlug = resolvedApp.app.slug,
): Array<Record<string, unknown>> {
	const appName = resolvedApp.app.name ?? "Tedix";
	const tools: Array<Record<string, unknown>> = [
		{
			name: "code",
			title: "Code Mode",
			annotations: CODE_MODE_TOOL_ANNOTATIONS,
			...codeModeSecurityMeta(resolvedApp.metadata?.mcpConfig),
			_meta: codeModeToolMeta(resolvedApp.metadata?.mcpConfig),
			description: compactCodeModeToolDescription(resolvedApp),
			inputSchema: z.toJSONSchema(codeModeInputSchema(connectionAppSlug)),
		},
		{
			name: "get_info",
			title:
				sidebarAppConfig(resolvedApp.metadata?.mcpConfig)?.title ??
				`${appName} Info`,
			_meta: sidebarAppToolMeta(
				resolvedApp.app.slug,
				resolvedApp.metadata?.mcpConfig,
			),
			description: `Get metadata about the ${appName} MCP server itself.`,
			inputSchema: { type: "object", properties: {} },
			annotations: {
				readOnlyHint: true,
				openWorldHint: false,
				destructiveHint: false,
			},
		},
		...(accountProfileEnabled(resolvedApp.metadata?.mcpConfig)
			? [accountProfileTool]
			: []),
	].filter(
		(tool) =>
			tool.name === "code" ||
			isCodeModeNativeOptIn(resolvedApp.metadata?.mcpConfig, tool.name),
	);
	const config = resolvedApp.metadata?.mcpConfig;
	const caller = parseMcpCallerFromHeaders(requestHeaders);
	const overrides = config?.codeModeNamespaces as
		| Record<string, string>
		| undefined;
	const rows = (resolvedApp.tools ?? []).filter((tool) =>
		isConfiguredCatalogTool(tool, config),
	);
	const names = new Map<string, number>();
	for (const tool of resolvedApp.tools ?? [])
		names.set(tool.toolId, (names.get(tool.toolId) ?? 0) + 1);
	const baseNames = new Set(tools.map((tool) => tool.name));
	for (const tool of rows) {
		if (names.get(tool.toolId) !== 1 || baseNames.has(tool.toolId)) continue;
		if (
			!isMcpToolVisibleToCaller(
				tool,
				resolveMcpToolNamespace(tool, overrides),
				config,
				caller,
			)
		)
			continue;
		if (
			requestHeaders.get("x-tedix-auth-credential-mode") === "delegated-mcp" &&
			isDelegatedWorkTool(
				tool.toolId,
				resolveMcpToolNamespace(tool, overrides),
				tool.config,
				tool.toolTypeId,
			)
		)
			continue;
		const scopes = resolveMcpToolRequiredScopes(
			tool,
			resolveMcpToolNamespace(tool, overrides),
			config,
		);
		const securitySchemes = [{ type: "oauth2", scopes }];
		tools.push({
			name: tool.toolId,
			title: tool.title,
			description: tool.description ?? "",
			inputSchema: tool.inputSchema,
			...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
			annotations: resolveToolAnnotations({
				annotations: tool.annotations,
				writeCapability: tool.writeCapability ?? null,
				meta: tool.meta,
			}),
			securitySchemes,
			_meta: { ...tool.meta, securitySchemes },
		});
	}
	// Directory listings read the display name from `annotations.title`
	// (the 2025-03-26 location); newer clients read the top-level `title`.
	for (const tool of tools) {
		const annotations = tool.annotations as Record<string, unknown> | undefined;
		if (typeof tool.title === "string" && annotations?.title === undefined)
			tool.annotations = { ...annotations, title: tool.title };
	}
	return sortToolsDeterministically(tools);
}

export async function maybeHandleCodeModeCompactMcp(
	request: Request,
	resolvedApp: ResolvedApp,
	env: CloudflareEnv,
	interactionEventsEnabled = false,
	connectionAppSlug = resolvedApp.app.slug,
): Promise<Response | null> {
	if (request.method !== "POST") return null;
	if (resolvedApp.metadata?.mcpConfig?.codeMode !== true) return null;
	// Legacy hosts use the SDK's initialization and response codec below.
	if (
		request.headers.get(MCP_PROTOCOL_VERSION_HEADER) !==
		MCP_MODERN_PROTOCOL_VERSION
	)
		return null;

	const envelope = await readJsonRpcEnvelope(request);
	if (envelope && "tooLarge" in envelope) return requestBodyTooLargeResponse();
	if (!envelope) return null;
	const body = envelope.body;
	const method = typeof body.method === "string" ? body.method : "";
	if (method === "initialize") {
		return jsonRpcEnvelopeErrorResponse(
			envelope,
			-32_601,
			"Method not found: the initialize handshake is removed in MCP 2026-07-28; use server/discover",
		);
	}
	const modernError = validateModernFastPathRequest(request, envelope);
	if (modernError) return modernError;

	if (method === "server/discover") {
		const exposesHomeTasks = shouldExposeHomeSurface({
			appSlug: resolvedApp.app.slug,
			metadata: resolvedApp.metadata,
		});
		const hasSubscriptionStream = Boolean(
			(env as McpSubscriptionBindingEnv).MCP_SUBSCRIPTIONS,
		);
		return jsonRpcEnvelopeResponse(
			envelope,
			decorateModernFastPathResult(envelope, resolvedApp, {
				resultType: "complete",
				supportedVersions: MCP_SUPPORTED_PROTOCOL_VERSIONS,
				capabilities: {
					...(interactionEventsEnabled ? { events: {} } : {}),
					tools: hasSubscriptionStream ? { listChanged: true } : {},
					resources: hasSubscriptionStream
						? { listChanged: true, subscribe: true }
						: {},
					extensions: {
						"io.modelcontextprotocol/apps": {},
						"io.modelcontextprotocol/ui": {},
						"io.modelcontextprotocol/skills": {},
						...(interactionEventsEnabled ? { [MCP_EVENTS_EXTENSION]: {} } : {}),
						...(exposesHomeTasks ? { [MCP_TASKS_EXTENSION]: {} } : {}),
					},
				},
				instructions: modernDiscoverInstructions(
					resolvedApp,
					connectionAppSlug,
				),
				...DEFAULT_MCP_CACHE_HINT,
			}),
		);
	}

	if (method === "tools/list") {
		// Only explicitly configured native widget tools need the hydrated
		// session surface; by default Code Mode lists `code` alone.
		const nativeToolNames =
			resolvedApp.metadata?.mcpConfig?.codeModeNativeTools;
		if (
			clientSupportsMcpApps(body) &&
			Array.isArray(nativeToolNames) &&
			nativeToolNames.length > 0 &&
			((resolvedApp.tools ?? []).some(
				(tool) =>
					tool.config?.nativeDirect === true &&
					resolveToolWidgetRoute(tool) &&
					nativeToolNames.includes(tool.toolId),
			) ||
				(Array.isArray(resolvedApp.metadata?.mcpConfig?.aggregateApps) &&
					resolvedApp.metadata.mcpConfig.aggregateApps.length > 0) ||
				resolvedApp.metadata?.mcpConfig?.multiOrgConsent === true)
		)
			return null;
		// SEP-2549 CacheableResult on this fast path: the 60s/private default
		// mirrors the app-resolution cache backing the compact tool list
		// (APP_RESOLUTION_TTL_MS in resolution.ts).
		const page = paginateSortedToolsList(
			compactCodeModeTools(resolvedApp, request.headers, connectionAppSlug),
			isRecord(body.params) ? body.params.cursor : undefined,
		);
		if (!page.ok)
			return jsonRpcEnvelopeErrorResponse(
				envelope,
				-32_602,
				"Invalid params: unrecognized tools/list cursor",
			);
		return jsonRpcEnvelopeResponse(
			envelope,
			decorateModernFastPathResult(envelope, resolvedApp, {
				resultType: "complete",
				tools: page.tools,
				...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
				...DEFAULT_MCP_CACHE_HINT,
			}),
		);
	}

	return null;
}
