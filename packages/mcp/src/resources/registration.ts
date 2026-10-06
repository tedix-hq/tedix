/**
 * @tedix/mcp — Resource & Resource Template Registration Helpers
 *
 * Utilities for registering MCP resources and resource templates
 * on an McpServer instance with consistent patterns.
 */
import { ResourceTemplate } from "@modelcontextprotocol/server";
import type {
	McpServer,
	ReadResourceTemplateCallback,
} from "@modelcontextprotocol/server";

// =============================================================================
// TYPES
// =============================================================================

/**
 * Definition for a static resource to register.
 */
export interface ResourceDefinition {
	/** Resource identifier (used in server.resource() as first arg) */
	id: string;
	/** Full resource URI (e.g., "info://app/status.json") */
	uri: string;
	/** Human-readable description */
	description?: string;
	/** MIME type of the resource content */
	mimeType?: string;
	/** Custom _meta fields */
	meta?: Record<string, unknown>;
	/** Handler that returns resource contents */
	handler: () => Promise<{
		contents: Array<{
			uri: string;
			mimeType?: string;
			text: string;
		}>;
	}>;
}

/**
 * Definition for a resource template (URI pattern with variables).
 */
export interface ResourceTemplateDefinition {
	/** Resource template identifier */
	id: string;
	/** URI template pattern (e.g., "tedi://{tediSlug}/status") */
	uriTemplate: string;
	/** Human-readable description */
	description?: string;
	/** Custom _meta fields */
	meta?: Record<string, unknown>;
	/** Handler that resolves the template with variables — matches SDK ReadResourceTemplateCallback */
	handler: ReadResourceTemplateCallback;
}

// =============================================================================
// REGISTRATION
// =============================================================================

/**
 * Register multiple static resources on an McpServer.
 *
 * @example
 * ```ts
 * registerResources(server, [
 *   {
 *     id: "app-info",
 *     uri: "info://myapp/info.json",
 *     description: "App information",
 *     mimeType: "application/json",
 *     handler: async () => ({
 *       contents: [{ uri: "info://myapp/info.json", text: "{}" }],
 *     }),
 *   },
 * ]);
 * ```
 */
export function registerResources(
	server: McpServer,
	resources: ResourceDefinition[],
): void {
	for (const resource of resources) {
		server.registerResource(
			resource.id,
			resource.uri,
			{
				description: resource.description,
				...(resource.mimeType && { mimeType: resource.mimeType }),
				...(resource.meta && { _meta: resource.meta }),
			},
			resource.handler,
		);
	}
}

/**
 * Register multiple resource templates on an McpServer.
 *
 * @example
 * ```ts
 * registerResourceTemplates(server, [
 *   {
 *     id: "tedi-status",
 *     uriTemplate: "tedi://{tediSlug}/status",
 *     description: "Live tedi runtime status",
 *     handler: async (uri, vars) => ({
 *       contents: [{ uri: uri.toString(), text: "..." }],
 *     }),
 *   },
 * ]);
 * ```
 */
export function registerResourceTemplates(
	server: McpServer,
	templates: ResourceTemplateDefinition[],
): void {
	for (const template of templates) {
		server.registerResource(
			template.id,
			new ResourceTemplate(template.uriTemplate, { list: undefined }),
			{
				description: template.description,
				...(template.meta && { _meta: template.meta }),
			},
			template.handler,
		);
	}
}
