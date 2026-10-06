/**
 * Per-request context for stateless MCP server.
 *
 * Replaces AgentContext (DO-bound). Built fresh per request with caller
 * identity from validated JWT headers. Tool handler closures capture this
 * context — never cache it across requests.
 *
 * @module @tedix/mcp/mcp/server-context
 */
import type {
	McpServer,
	RegisteredPrompt,
	RegisteredResource,
	RegisteredTool,
} from "@modelcontextprotocol/server";
import type {
	AppCapabilities,
	AppMetadata,
} from "@tedix/api-contract/schemas/app";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type {
	CatalogueTransportCallback,
	ToolAnnotations,
	ToolIcon,
	ToolInputJsonSchema,
	ToolInvocationStatus,
	ToolJsonSchema,
	ToolSchemaDialect,
	ToolSchemaSource,
	ToolWriteCapability,
} from "@tedix/api-contract/schemas/tools";
import type { ApiClient } from "../lib/api-client";
import type { ToolExecutionContext, ToolHandler } from "./handler";
import type { McpApp, OpenAiWidgetCSP } from "./types";

/**
 * Tool data from API (matches getBySlugWithTools response)
 *
 * All JSON fields (inputSchema, outputSchema, config, annotations,
 * invocationStatus, fileParams) use Drizzle mode: "json" and arrive as
 * parsed objects (or null) — no manual deserialization needed.
 */
export interface AppTool {
	id: string;
	toolId: string;
	title: string;
	description: string | null;
	toolTypeId: string;
	inputSchema: ToolInputJsonSchema;
	outputSchema: ToolJsonSchema | null;
	config: Record<string, JsonValue> | null;
	icons: ToolIcon[] | null;
	executionTaskSupport: "forbidden" | "optional" | "required" | null;
	annotations: ToolAnnotations | null;
	/**
	 * declared write capability. Absent or `null` is undeclared (gated), not
	 * read-only — code-built tools that carry explicit annotations simply omit it.
	 */
	writeCapability?: ToolWriteCapability | null;
	meta: Record<string, JsonValue> | null;
	invocationStatus: ToolInvocationStatus | null;
	fileParams: string[] | null;
	adapterScope: string | null;
	resultStrategy: string | null;
	outputTemplate: string | null;
	widgetKey: string | null;
	widgetRoute: string | null;
	widgetAccessible: boolean | null;
	visibility: string | null;
	widgetDescription: string | null;
	widgetPrefersBorder: boolean | null;
	widgetDomain: string | null;
	schemaDialect: ToolSchemaDialect | null;
	schemaSource: ToolSchemaSource | null;
	schemaSourceRef: string | null;
	schemaSourceHash: string | null;
	schemaSyncedAt: string | null;
	authRequired?: boolean;
	sortOrder: number | null;
	enabled: boolean | null;
	createdAt: string | null;
	updatedAt: string | null;
	toolCspDomains?: Array<{
		toolId: string;
		domainType:
			| "connect"
			| "resource"
			| "img"
			| "script"
			| "style"
			| "frame"
			| "redirect";
		domainUrl: string;
		active?: boolean;
	}>;
}

export interface CatalogMcpMetadata {
	id: string;
	slug: string | null;
	mcpEndpointNormalized: string | null;
	baseUrl: string | null;
	scanConnectionId: string | null;
	scanConnectionHeader: string | null;
	scanConnectionTemplate: string | null;
}

export interface CatalogMcpResource {
	id: string;
	uri: string;
	name: string | null;
	title: string | null;
	description: string | null;
	mimeType: string | null;
	icons?: ToolIcon[] | null;
	annotations?: {
		audience?: string[];
		priority?: number;
		lastModified?: string;
	} | null;
	meta?: Record<string, unknown> | null;
	sourceAppSlug?: string | null;
	sourceAppId?: string | null;
	catalogMcp?: CatalogMcpMetadata | null;
	connectionProviderId?: string | null;
	connectionScope?: "tenant" | "user" | "hybrid" | null;
	connectionScopes?: string[] | null;
}

export interface CatalogMcpResourceTemplate {
	id: string;
	name: string;
	title: string | null;
	uriTemplate: string;
	description: string | null;
	mimeType: string | null;
	icons?: ToolIcon[] | null;
	annotations?: {
		audience?: string[];
		priority?: number;
		lastModified?: string;
	} | null;
	meta?: Record<string, unknown> | null;
	sourceAppSlug?: string | null;
	sourceAppId?: string | null;
	catalogMcp?: CatalogMcpMetadata | null;
	connectionProviderId?: string | null;
	connectionScope?: "tenant" | "user" | "hybrid" | null;
	connectionScopes?: string[] | null;
}

export interface CatalogMcpPrompt {
	id: string;
	promptName: string;
	upstreamPromptName?: string;
	title?: string | null;
	description: string | null;
	arguments: Array<{
		name: string;
		description?: string;
		required?: boolean;
	}> | null;
	icons?: ToolIcon[] | null;
	annotations?: {
		audience?: string[];
		priority?: number;
		lastModified?: string;
	} | null;
	meta?: Record<string, unknown> | null;
	sourceAppSlug?: string | null;
	catalogMcp?: CatalogMcpMetadata | null;
	connectionProviderId?: string | null;
	connectionScope?: "tenant" | "user" | "hybrid" | null;
	connectionScopes?: string[] | null;
}

export type CallerIdentity = ToolExecutionContext["callerIdentity"];

/**
 * Per-request server context. Built by server-factory.ts.
 * Tool handler closures close over this — it contains the fresh caller
 * identity for the current request.
 */
export interface ServerContext {
	readonly server: McpServer;
	readonly env: CloudflareEnv;
	readonly ctx: { waitUntil: (promise: Promise<unknown>) => void };

	// App identity (from cache)
	readonly appId: string;
	readonly appSlug: string;
	readonly app: McpApp;
	readonly appMetadata: AppMetadata | null;
	readonly appCapabilities: AppCapabilities;

	// API & handler
	readonly apiClient: ApiClient;
	readonly toolHandler: ToolHandler;
	readonly catalogTransport?: CatalogueTransportCallback;

	// Caller identity (per-request, from JWT headers)
	readonly callerIdentity: CallerIdentity | undefined;

	// Per-request trace ID for cross-layer correlation
	readonly traceId: string;

	// Optional W3C tracestate chain to preserve for outbound MCP hops.
	readonly tracestate: string | undefined;

	/** Inbound MCP request _meta. Carries trace context plus Tedix run linkage. */
	readonly requestMeta: Record<string, unknown> | undefined;

	/**
	 * Namespaces this request's Code Mode snippet was parsed as referencing
	 * (`extractCodeModeProviderNamespacesFromCode`), or `null` when the whole
	 * aggregate surface was hydrated (a `discover.` snippet, or a non-Code-Mode
	 * request). Lets the sandbox tell "your snippet never asked for this
	 * namespace" apart from "it asked and hydration failed".
	 */
	readonly requestedCodeModeNamespaces: ReadonlySet<string> | null;

	/** Legacy per-project connection label forwarded via X-Tedix-Connection-Label. */
	readonly connectionLabel: string | undefined;

	/** Original bearer token from the authenticated request. Forwarded to
	 *  upstream service bindings for auth proxy. */
	readonly bearerToken: string | undefined;

	/** Reference app ID for skill inheritance. When an org-personalized app
	 *  proxies to a reference app via same-zone upstream, skills from the
	 *  reference app are inherited if the org app has none of its own. */
	readonly upstreamAppId: string | undefined;

	// Per-request mutable collections (not shared across requests)
	readonly registeredTools: Map<string, RegisteredTool>;
	readonly registeredResources: Map<string, RegisteredResource>;
	readonly loadedTools: Map<string, AppTool>;
	readonly catalogResources: CatalogMcpResource[];
	readonly catalogResourceTemplates: CatalogMcpResourceTemplate[];
	readonly catalogPrompts: CatalogMcpPrompt[];
	readonly appToolIds: Set<string>;
	readonly appResourceIds: Set<string>;
	readonly authRequiredTools: Set<string>;
	readonly registeredPrompts: Map<string, RegisteredPrompt>;
	readonly toolOutputTemplates: Map<string, string>;
	readonly toolSkillMap: Map<
		string,
		Array<{ id: string; title: string; uri: string }>
	>;

	// Methods
	getServerVersion(): string;
	getWidgetDomain(): string;
	buildAppCsp(tool?: AppTool): Promise<OpenAiWidgetCSP>;
	fetchWidgetHtml(
		route: string,
		description: string,
		hostType: "apps-sdk" | "mcp-app",
		extraHeaders?: Record<string, string>,
	): Promise<string>;
	fetchWidgetHtmlForAppSlug(
		appSlug: string,
		route: string,
		description: string,
		hostType: "apps-sdk" | "mcp-app",
		extraHeaders?: Record<string, string>,
	): Promise<string>;
}
