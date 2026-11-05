/**
 * The native catalog pair (`search_native_tools` / `get_native_tool_schema`)
 * that the CLI calls before every `tedix work` command. The gateway builds it
 * from code for every organization gateway, so it can never drift from the
 * catalog parser and needs no stored rows or `toolScopes` entry.
 */

import {
	CatalogueDescribeInputJsonSchema,
	CatalogueSearchInputJsonSchema,
	type CatalogueTransportConfig,
	ToolInputJsonSchemaSchema,
} from "@tedix/api-contract/schemas/tools";
import type { AppTool } from "./server-context";

/**
 * Results are filtered per row (`authorized` / `missingScopes`) and every real
 * call is checked again, so the pair only reveals tool names. Organization
 * members get this scope with `apps:read`.
 */
export const NATIVE_CATALOG_REQUIRED_SCOPES: readonly string[] = [
	"mcp:catalog.read",
];

// The declaration is code, built with the deploy; this only satisfies clients
// that require a parseable provenance timestamp.
const DECLARED_AT = "2026-11-05T00:00:00.000Z";

/** FNV-1a: a stable fingerprint of the declared input schema. */
function schemaHash(schema: unknown): string {
	let hash = 0x811c9dc5;
	for (const char of JSON.stringify(schema)) {
		hash ^= char.charCodeAt(0);
		hash = Math.imul(hash, 0x01000193);
	}
	return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function buildNativeCatalogTool(spec: {
	id: string;
	toolId: string;
	endpoint: CatalogueTransportConfig["endpoint"];
	description: string;
	inputSchema: unknown;
	schemaName: string;
}): AppTool {
	const inputSchema = ToolInputJsonSchemaSchema.parse(spec.inputSchema);
	const config: CatalogueTransportConfig = {
		transport: "catalog",
		endpoint: spec.endpoint,
		nativeDirect: true,
	};
	return {
		id: spec.id,
		toolId: spec.toolId,
		title: spec.toolId,
		description: spec.description,
		toolTypeId: "rpc",
		inputSchema,
		outputSchema: null,
		config,
		annotations: {
			readOnlyHint: true,
			idempotentHint: true,
			destructiveHint: false,
			openWorldHint: false,
		},
		writeCapability: "read",
		authRequired: true,
		meta: null,
		icons: null,
		executionTaskSupport: null,
		invocationStatus: null,
		fileParams: null,
		adapterScope: null,
		resultStrategy: null,
		outputTemplate: null,
		widgetKey: null,
		widgetRoute: null,
		widgetAccessible: null,
		visibility: null,
		widgetDescription: null,
		widgetPrefersBorder: null,
		widgetDomain: null,
		schemaDialect: "json-schema-2020-12",
		schemaSource: "manual",
		schemaSourceRef: `@tedix/api-contract/schemas/tools:${spec.schemaName}`,
		schemaSourceHash: schemaHash(inputSchema),
		schemaSyncedAt: DECLARED_AT,
		sortOrder: null,
		enabled: true,
		createdAt: null,
		updatedAt: null,
	};
}

export const NATIVE_CATALOG_TOOLS: readonly AppTool[] = [
	buildNativeCatalogTool({
		id: "native-catalog:search",
		toolId: "search_native_tools",
		endpoint: "catalog/search",
		description:
			"Search the tools this connection can see in this organization. Each result says whether you may call it; every call is checked again.",
		inputSchema: CatalogueSearchInputJsonSchema,
		schemaName: "CatalogueSearchInputJsonSchema",
	}),
	buildNativeCatalogTool({
		id: "native-catalog:describe",
		toolId: "get_native_tool_schema",
		endpoint: "catalog/describe",
		description:
			"Get the input and output schema of one tool, named namespace.tool as search returns it.",
		inputSchema: CatalogueDescribeInputJsonSchema,
		schemaName: "CatalogueDescribeInputJsonSchema",
	}),
];

/**
 * Structural identity: request copies (`copyCatalogTool`) keep these fields,
 * and stored catalog rows are removed before the pair is added.
 */
export function isNativeCatalogTool(tool: {
	id?: string;
	toolId: string;
	config?: Record<string, unknown> | null;
}): boolean {
	return NATIVE_CATALOG_TOOLS.some(
		(builtin) =>
			builtin.id === tool.id &&
			builtin.toolId === tool.toolId &&
			tool.config?.transport === "catalog" &&
			builtin.config?.endpoint === tool.config?.endpoint,
	);
}

/**
 * Code Mode gateways (every organization gateway is provisioned with
 * `codeMode: true`) serve the pair: it is the native front of the Code Mode
 * catalog. Multi-organization Connect stays `code` + `get_info`; a selected
 * organization is answered by its own gateway. Descope policy mode requires a
 * per-tool `mcp:<tool>` scope at the edge that CLI credentials do not hold, so
 * the pair would be advertised and then refused there.
 */
export function servesNativeCatalog(
	appSlug: string,
	metadata: { mcpConfig?: Record<string, unknown> | null } | null | undefined,
): boolean {
	const mcpConfig = metadata?.mcpConfig;
	return (
		mcpConfig?.codeMode === true &&
		mcpConfig.enforcePolicies !== true &&
		!(appSlug === "connect" && mcpConfig.multiOrgConsent === true)
	);
}

/** Stored catalog rows never serve; the gateway adds the built-in pair. */
export function withNativeCatalogTools(
	tools: AppTool[],
	appSlug: string,
	metadata: { mcpConfig?: Record<string, unknown> | null } | null | undefined,
): AppTool[] {
	const rest = tools.filter((tool) => tool.config?.transport !== "catalog");
	return servesNativeCatalog(appSlug, metadata)
		? [
				...rest,
				// Per-request copies: request code may annotate a tool in place.
				...NATIVE_CATALOG_TOOLS.map((tool) => ({
					...tool,
					config: { ...tool.config },
				})),
			]
		: rest;
}
