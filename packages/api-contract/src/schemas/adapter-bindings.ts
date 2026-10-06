/**
 * Adapter Binding Specifications
 *
 * Declarative specifications for adapter secret bindings.
 * This is the single source of truth for:
 * - Required/optional binding slots per adapter type
 * - Non-sensitive config fields that stay in adapter.config
 * - Validation logic for bindings
 *
 * Shared between API runtime validation and OS form validation.
 *
 * @module @tedix/api-contract/schemas/adapter-bindings
 */

import * as z from "zod";
// Import canonical AdapterType from adapters schema to prevent drift
import { ADAPTER_TYPES, type AdapterType, AdapterTypeSchema } from "./adapters";

// Re-export for convenience
export { ADAPTER_TYPES, type AdapterType, AdapterTypeSchema };

// =============================================================================
// TYPES
// =============================================================================

/**
 * Secret scope discriminator
 * Determines which secrets table the binding references
 */
export type SecretScope = "app" | "organization";

export const SECRET_SCOPES = ["app", "organization"] as const;

/**
 * Binding slot specification for an adapter type
 * Defines a required or optional secret binding with metadata
 */
export interface BindingSlot {
	/** Secret name in app_secrets table (e.g., "SHOPIFY_TOKEN") */
	secretName: string;

	/** Human-readable label for UI (e.g., "Shopify Token") */
	label: string;

	/** Description/help text for UI */
	description: string;

	/** Whether this binding is required for the adapter to function */
	required: boolean;

	/** Config path this binding populates (e.g., "apiKey", "auth.token") */
	configKey: string;

	/** Validation pattern for secret value (optional) */
	pattern?: RegExp;

	/** Example value for documentation/hints */
	example?: string;

	/** Where to find this credential (help link) */
	docsUrl?: string;
}

/**
 * Config field definition for adapter type
 */
export interface ConfigFieldSpec {
	/** Field name in config object */
	name: string;
	/** TypeScript type for documentation */
	type: string;
	/** Whether field is required */
	required: boolean;
	/** Default value if not provided */
	defaultValue?: unknown;
	/** Description for UI */
	description?: string;
}

/**
 * Complete specification for an adapter type
 */
export interface AdapterTypeSpec {
	/** Adapter type identifier */
	type: AdapterType;

	/** Human-readable name */
	name: string;

	/** Description for UI */
	description: string;

	/** Binding slots required/supported by this adapter */
	bindings: BindingSlot[];

	/** Non-sensitive config fields that stay in adapter.config */
	configFields: ConfigFieldSpec[];

	/** Whether this adapter type supports field mappings */
	supportsFieldMappings: boolean;

	/** Suggested verticals for this adapter type */
	suggestedVerticals?: string[];
}

// =============================================================================
// ZOD SCHEMAS
// =============================================================================

/**
 * Zod schema for secret scope validation
 */
export const SecretScopeSchema = z.enum(["app", "organization"]);

// Note: AdapterTypeSchema is imported and re-exported from ./adapters

/**
 * Zod schema for binding slot validation
 */
export const BindingSlotSchema = z.object({
	secretName: z.string().min(1),
	label: z.string().min(1),
	description: z.string(),
	required: z.boolean(),
	configKey: z.string().min(1),
	example: z.string().optional(),
	docsUrl: z.url().optional(),
});

// =============================================================================
// ADAPTER TYPE SPECIFICATIONS
// =============================================================================

/**
 * ADAPTER_TYPE_SPECS
 *
 * Declarative specifications for all adapter types.
 * This is the single source of truth for binding requirements.
 */
export const ADAPTER_TYPE_SPECS: Record<AdapterType, AdapterTypeSpec> = {
	klarna: {
		type: "klarna",
		name: "Klarna Shopping MCP",
		description:
			"Price comparison across 8+ European markets via Klarna's official MCP server",
		bindings: [],
		configFields: [
			{
				name: "markets",
				type: "string[]",
				required: false,
				defaultValue: ["DE"],
				description: "Supported markets (e.g., ['DE', 'SE', 'DK'])",
			},
			{
				name: "defaultMarket",
				type: "string",
				required: false,
				defaultValue: "DE",
				description: "Default market for searches",
			},
			{
				name: "fetchOffers",
				type: "boolean",
				required: false,
				defaultValue: true,
				description: "Whether to fetch offers (Phase 2 of search)",
			},
			{
				name: "maxProducts",
				type: "number",
				required: false,
				defaultValue: 20,
				description: "Max products per search",
			},
		],
		supportsFieldMappings: true,
		suggestedVerticals: ["ecommerce", "price_comparison"],
	},

	shopify: {
		type: "shopify",
		name: "Shopify",
		description: "Connect your Shopify store via Storefront API",
		bindings: [
			{
				secretName: "SHOPIFY_STOREFRONT_TOKEN",
				label: "Storefront Access Token",
				description: "Storefront API access token from Shopify admin",
				required: true,
				configKey: "storefrontToken",
				pattern: /^[a-zA-Z0-9]{32}$/,
				example: "shpat_abc123def456...",
				docsUrl: "https://shopify.dev/docs/api/storefront",
			},
			// NOTE: storeDomain stays in config (non-sensitive per design decision)
		],
		configFields: [
			{
				name: "storeDomain",
				type: "string",
				required: true,
				description: "Your Shopify store domain (e.g., mystore.myshopify.com)",
			},
			{
				name: "apiVersion",
				type: "string",
				required: false,
				defaultValue: "2024-01",
				description: "Shopify API version (e.g., '2024-01')",
			},
			{
				name: "includeVariants",
				type: "boolean",
				required: false,
				defaultValue: true,
				description: "Whether to include product variants",
			},
			{
				name: "collectionIds",
				type: "string[]",
				required: false,
				description: "Collection IDs to include (empty = all)",
			},
		],
		supportsFieldMappings: true,
		suggestedVerticals: ["ecommerce"],
	},

	custom: {
		type: "custom",
		name: "Custom API",
		description: "Connect any REST API with custom field mappings",
		bindings: [
			{
				secretName: "CUSTOM_API_KEY",
				label: "API Key",
				description: "API key or bearer token for authentication",
				required: false, // Custom APIs may not require auth
				configKey: "auth.token",
				example: "sk_live_abc123...",
			},
			{
				secretName: "CUSTOM_API_USERNAME",
				label: "Username",
				description: "Username for Basic authentication",
				required: false,
				configKey: "auth.username",
			},
			{
				secretName: "CUSTOM_API_PASSWORD",
				label: "Password",
				description: "Password for Basic authentication",
				required: false,
				configKey: "auth.password",
			},
			{
				secretName: "CUSTOM_OAUTH_CLIENT_ID",
				label: "OAuth Client ID",
				description: "OAuth 2.0 client ID",
				required: false,
				configKey: "auth.oauth2.clientId",
			},
			{
				secretName: "CUSTOM_OAUTH_CLIENT_SECRET",
				label: "OAuth Client Secret",
				description: "OAuth 2.0 client secret",
				required: false,
				configKey: "auth.oauth2.clientSecret",
			},
		],
		configFields: [
			{
				name: "baseUrl",
				type: "string",
				required: true,
				description: "Base URL for API requests",
			},
			{
				name: "endpoints.search",
				type: "string",
				required: false,
				description: "Search endpoint path (e.g., '/api/search')",
			},
			{
				name: "endpoints.detail",
				type: "string",
				required: false,
				description: "Detail endpoint path (e.g., '/api/products/:id')",
			},
			{
				name: "auth.type",
				type: "'none' | 'bearer' | 'api_key' | 'basic' | 'oauth2'",
				required: true,
				defaultValue: "none",
				description: "Authentication type",
			},
			{
				name: "auth.headerName",
				type: "string",
				required: false,
				description: "Header name for API key auth (e.g., 'X-API-Key')",
			},
			{
				name: "headers",
				type: "Record<string, string>",
				required: false,
				description: "Custom headers to include",
			},
			{
				name: "itemsPath",
				type: "string",
				required: false,
				description: "Path to items array in response (e.g., 'data.products')",
			},
		],
		supportsFieldMappings: true,
		suggestedVerticals: ["*"],
	},

	webhook: {
		type: "webhook",
		name: "Webhook",
		description: "Receive real-time data updates via webhooks",
		bindings: [
			{
				secretName: "WEBHOOK_SECRET",
				label: "Webhook Secret",
				description: "Secret for signature verification",
				required: false,
				configKey: "secret",
				example: "whsec_abc123...",
			},
		],
		configFields: [
			{
				name: "webhookUrl",
				type: "string",
				required: false,
				description: "Webhook endpoint URL (our endpoint that receives data)",
			},
			{
				name: "events",
				type: "string[]",
				required: false,
				description:
					"Events to subscribe to (e.g., ['product.created', 'product.updated'])",
			},
			{
				name: "registrationUrl",
				type: "string",
				required: false,
				description: "Source webhook URL (their endpoint to register with)",
			},
		],
		supportsFieldMappings: true,
		suggestedVerticals: ["*"],
	},

	mcp: {
		type: "mcp",
		name: "External MCP",
		description: "Use a third-party MCP server as a data source",
		bindings: [], // No secrets required — service-binding auth uses the Worker's own MCP_SERVICE binding + PLATFORM_SERVICE_TOKEN, not a stored secret
		configFields: [
			{
				name: "serverUrl",
				type: "string",
				required: true,
				description: "Remote MCP server URL",
			},
			{
				name: "toolMap.search",
				type: "string",
				required: true,
				description: "Tool name for search (e.g., search_ads)",
			},
			{
				name: "toolMap.categoryRef",
				type: "string",
				required: false,
				description: "Optional tool name for category reference",
			},
			{
				name: "categoryRefRequired",
				type: "boolean",
				required: false,
				description: "Whether to always call category reference when available",
			},
			{
				name: "allowGeneric",
				type: "boolean",
				required: false,
				description: "Allow search without category reference",
			},
			{
				name: "includeUserText",
				type: "boolean",
				required: false,
				description: "Include userText in search args",
			},
			{
				name: "categoryRefInput.categoryKey",
				type: "string",
				required: false,
				description: "Category key for category reference tool input",
			},
			{
				name: "categoryRefInput.categoryHintKey",
				type: "string",
				required: false,
				description: "Category hint key for category reference tool input",
			},
			{
				name: "categoryRefInput.userTextKey",
				type: "string",
				required: false,
				description: "userText key for category reference tool input",
			},
			{
				name: "searchInput.queryKey",
				type: "string",
				required: false,
				description: "Query key for search tool input",
			},
			{
				name: "searchInput.queriesKey",
				type: "string",
				required: false,
				description: "Queries key for search tool input",
			},
			{
				name: "searchInput.useQueries",
				type: "boolean",
				required: false,
				description: "Send queries[] array instead of query",
			},
			{
				name: "searchInput.userTextKey",
				type: "string",
				required: false,
				description: "userText key for search tool input",
			},
			{
				name: "searchArgs",
				type: "Record<string, unknown>",
				required: false,
				description: "Extra args to merge into search tool call",
			},
			{
				name: "categoryRefArgs",
				type: "Record<string, unknown>",
				required: false,
				description: "Extra args to merge into category reference tool call",
			},
			{
				name: "itemsPath",
				type: "string",
				required: false,
				description: "Path to items array in MCP response",
			},
			{
				name: "totalPath",
				type: "string",
				required: false,
				description: "Path to total count in MCP response",
			},
			{
				name: "categoryRefIdPath",
				type: "string",
				required: false,
				description: "Path to categoryRefId in category reference response",
			},
			{
				name: "categoryPath",
				type: "string",
				required: false,
				description: "Path to category in category reference response",
			},
			{
				name: "attributesPath",
				type: "string",
				required: false,
				description: "Path to attributes in category reference response",
			},
			{
				name: "auth.type",
				type: '"service-binding"',
				required: false,
				description:
					"Route through Tedix's own mcp gateway over the MCP_SERVICE binding instead of fetching serverUrl directly (for internal aggregate entries already gated by their own auth, e.g. client_credentials-backed catalog apps)",
			},
			{
				name: "auth.organizationId",
				type: "string",
				required: false,
				description:
					"Organization to scope the service-binding call to (sent as X-Tedix-Org-Id)",
			},
			{
				name: "auth.mcpSlug",
				type: "string",
				required: false,
				description:
					'Aggregator app slug used to build X-Tedix-Host (e.g. "tedix-unified")',
			},
		],
		supportsFieldMappings: true,
		suggestedVerticals: ["*"],
	},

	internal: {
		type: "internal",
		name: "Internal",
		description: "Connect to Tedix internal API endpoints (RPC/REST)",
		bindings: [
			{
				secretName: "TEDIX_API_TOKEN",
				label: "Tedix API Token",
				description:
					"Optional Bearer token or API key for Tedix API auth (recommended for REST mode)",
				required: false,
				configKey: "auth.token",
				example: "sk_live_abc123...",
			},
		],
		configFields: [
			{
				name: "endpoint",
				type: "string",
				required: true,
				description: "Endpoint path (e.g., /rpc/catalog/apps or /catalog/apps)",
			},
			{
				name: "transport",
				type: '"rpc" | "rest"',
				required: false,
				defaultValue: "rpc",
				description: "Invocation transport",
			},
			{
				name: "method",
				type: '"GET" | "POST"',
				required: false,
				defaultValue: "GET",
				description: "REST method (only for transport=rest)",
			},
			{
				name: "auth.type",
				type: '"none" | "bearer" | "api_key"',
				required: false,
				defaultValue: "none",
				description: "Auth mode used with auth.token",
			},
			{
				name: "auth.headerName",
				type: "string",
				required: false,
				description: "Header name for api_key auth (default X-API-Key)",
			},
			{
				name: "paramMap",
				type: "Record<string, string>",
				required: false,
				description: "Map standard search params to endpoint-specific keys",
			},
			{
				name: "staticParams",
				type: "Record<string, unknown>",
				required: false,
				description: "Static params merged into each request",
			},
			{
				name: "itemsPath",
				type: "string",
				required: false,
				description: "Path to items array in response",
			},
			{
				name: "totalPath",
				type: "string",
				required: false,
				description: "Path to total count in response",
			},
			{
				name: "sourcePath",
				type: "string",
				required: false,
				description: "Path to source label in response",
			},
			{
				name: "sourceLabel",
				type: "string",
				required: false,
				description: "Static source label override",
			},
		],
		supportsFieldMappings: true,
		suggestedVerticals: ["*"],
	},
};

// =============================================================================
// VALIDATION TYPES
// =============================================================================

/**
 * Validation result for adapter bindings
 */
export interface BindingValidationResult {
	/** Whether all required bindings are present */
	valid: boolean;

	/** Missing required binding config keys */
	missing: string[];

	/** Warnings for optional bindings */
	warnings: string[];

	/** Errors from pattern validation */
	errors: Array<{ configKey: string; message: string }>;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get required binding slots for an adapter type
 *
 * @param adapterType - Adapter type to get bindings for
 * @returns Array of required binding slots
 *
 * @example
 * const requiredBindings = getRequiredBindings("klarna");
 * // Returns: [] for public MCP-backed providers
 */
export function getRequiredBindings(adapterType: AdapterType): BindingSlot[] {
	const spec = ADAPTER_TYPE_SPECS[adapterType];
	if (!spec) {
		throw new Error(`Unknown adapter type: ${adapterType}`);
	}

	return spec.bindings.filter((binding) => binding.required);
}

/**
 * Validate that required bindings are present for an adapter type
 *
 * @param adapterType - Adapter type to validate
 * @param bindings - Map of config keys to values (or existence check)
 * @param options - Validation options
 * @returns Validation result with missing bindings and errors
 *
 * @example
 * const result = validateBindings("shopify", { storefrontToken: "..." });
 * if (!result.valid) {
 *   console.error("Missing bindings:", result.missing);
 * }
 */
export function validateBindings(
	adapterType: AdapterType,
	bindings: Record<string, string | null | undefined>,
	options: {
		/** Validate values against pattern (default: false, only check presence) */
		validateValues?: boolean;
		/** Include warnings for missing optional bindings */
		includeWarnings?: boolean;
	} = {},
): BindingValidationResult {
	const spec = ADAPTER_TYPE_SPECS[adapterType];
	if (!spec) {
		return {
			valid: false,
			missing: [],
			warnings: [],
			errors: [
				{ configKey: "_spec", message: `Unknown adapter type: ${adapterType}` },
			],
		};
	}

	const missing: string[] = [];
	const warnings: string[] = [];
	const errors: Array<{ configKey: string; message: string }> = [];

	for (const binding of spec.bindings) {
		const value = bindings[binding.configKey];

		// Check required bindings
		if (binding.required && !value) {
			missing.push(binding.configKey);
			continue;
		}

		// Warn about optional bindings
		if (!binding.required && !value && options.includeWarnings) {
			warnings.push(
				`Optional binding ${binding.configKey} not provided (${binding.description})`,
			);
			continue;
		}

		// Validate value against pattern if provided
		if (options.validateValues && value && binding.pattern) {
			if (!binding.pattern.test(value)) {
				errors.push({
					configKey: binding.configKey,
					message: `Value does not match expected format. Example: ${binding.example}`,
				});
			}
		}
	}

	return {
		valid: missing.length === 0 && errors.length === 0,
		missing,
		warnings,
		errors,
	};
}

/**
 * Get binding slot by config key
 *
 * @param adapterType - Adapter type
 * @param configKey - Config key to find
 * @returns Binding slot or undefined
 */
export function getBindingByConfigKey(
	adapterType: AdapterType,
	configKey: string,
): BindingSlot | undefined {
	const spec = ADAPTER_TYPE_SPECS[adapterType];
	if (!spec) {
		return undefined;
	}
	return spec.bindings.find((b) => b.configKey === configKey);
}

// =============================================================================
// CONFIG PATH UTILITIES
// =============================================================================

/**
 * Parse a config key path into segments
 *
 * @param configKey - Config key path (e.g., "auth.oauth2.clientId")
 * @returns Array of path segments (e.g., ["auth", "oauth2", "clientId"])
 */
export function parseConfigKeyPath(configKey: string): string[] {
	return configKey.split(".");
}

const UNSAFE_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * True for a dotted-path segment that would let a path setter reach
 * `Object.prototype` (prototype pollution). Path setters fed by tenant-authored
 * config or mappings must refuse such paths.
 */
export function isUnsafePathSegment(segment: string): boolean {
	return UNSAFE_PATH_SEGMENTS.has(segment);
}

/**
 * Set a nested value in a config object using a config key path
 * Creates intermediate objects as needed.
 *
 * @param config - Config object to mutate
 * @param configKey - Config key path (e.g., "auth.token")
 * @param value - Value to set
 *
 * @example
 * const config = {};
 * setByPath(config, "auth.oauth2.clientId", "abc123");
 * // Result: { auth: { oauth2: { clientId: "abc123" } } }
 */
export function setByPath(
	config: Record<string, unknown>,
	configKey: string,
	value: unknown,
): void {
	const path = parseConfigKeyPath(configKey);
	if (path.some(isUnsafePathSegment)) {
		throw new Error(`Unsafe config key path: ${configKey}`);
	}
	let current = config;

	// Navigate/create nested objects
	for (let i = 0; i < path.length - 1; i++) {
		const segment = path[i];
		if (!segment) continue;

		if (
			!(segment in current) ||
			typeof current[segment] !== "object" ||
			current[segment] === null
		) {
			current[segment] = {};
		}
		current = current[segment] as Record<string, unknown>;
	}

	// Set final value
	const finalKey = path[path.length - 1];
	if (finalKey) {
		current[finalKey] = value;
	}
}
