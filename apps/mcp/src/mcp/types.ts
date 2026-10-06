/**
 * MCP Types and Interfaces
 * Core type definitions for MCP tools, resources, and widgets
 */

// ============================================================================
// MCP App Type (subset from API response, not full D1 type)
// ============================================================================

/**
 * App data from API (matches getBySlugWithTools response)
 * This is a lighter-weight type than the full D1 App type.
 * MCP loads app data via API, not direct D1 access.
 */
export interface McpApp {
	id: string;
	organizationId?: string;
	name: string;
	slug: string;
	domain: string | null;
	description?: string | null;
	logoUrl?: string | null;
	customMcpDomain?: string | null;
	openaiChallengeToken?: string | null;
	openaiAppId?: string | null;
	appStoreStatus?: string | null;
	visibility?: string;
	discoveryStatus?: string | null;
}

// ============================================================================
// OpenAI Apps SDK Types
// ============================================================================

/**
 * Content Security Policy for Apps SDK widgets
 */
export interface OpenAiWidgetCSP {
	/** Allowed domains for fetch/XHR/WebSocket connections */
	connect_domains?: string[];
	/** Allowed domains for images, fonts, scripts, styles */
	resource_domains?: string[];
	/** Allowed domains for iframes */
	frame_domains?: string[];
	/** Allowed domains for redirects */
	redirect_domains?: string[];
}

/**
 * OpenAI widget metadata for Apps SDK
 * Uses index signature to allow additional properties required by MCP SDK
 */
export interface OpenAiWidgetMeta {
	[key: string]: unknown;
	"openai/outputTemplate"?: string;
	"openai/toolInvocation/invoking"?: string;
	"openai/toolInvocation/invoked"?: string;
	"openai/widgetAccessible"?: boolean;
	"openai/visibility"?: "public" | "private";
	"openai/fileParams"?: string[];
	"openai/resultCanProduceWidget"?: boolean;
	"openai/widgetDescription"?: string;
	"openai/widgetPrefersBorder"?: boolean;
	"openai/widgetDomain"?: string;
	"openai/widgetCSP"?: OpenAiWidgetCSP;
}
