/**
 * Connections Zod Schemas
 * Validation schemas for OAuth connection providers and user connections
 */

import * as z from "zod";
import { JsonValueSchema } from "./common";

const UrlParamSchema = z.object({
	key: z.string(),
	value: z.string(),
});

export const ConnectionCredentialFieldSchema = z.object({
	name: z.string().min(1),
	label: z.string().min(1),
	type: z.enum(["text", "password"]).default("password"),
	required: z.boolean().default(true),
	placeholder: z.string().optional(),
	helpText: z.string().optional(),
	defaultValue: z.string().optional(),
});

export type ConnectionCredentialField = z.infer<
	typeof ConnectionCredentialFieldSchema
>;

export const ConnectionCredentialScopeGroupSchema = z.object({
	id: z.string().min(1),
	label: z.string().min(1),
	description: z.string().optional(),
	scopes: z.array(z.string()),
});

export const ConnectionCredentialProfileSchema = z.object({
	/**
	 * Fields an operator UI should collect before uploading an API-key credential
	 * to Descope Token Vault. The API composes these fields into the final opaque
	 * token using `tokenTemplate`.
	 */
	inputFields: z.array(ConnectionCredentialFieldSchema).optional(),
	/**
	 * Template for the opaque value stored in Descope Token Vault.
	 * Example: "{projectId}:{managementKey}" for Descope management auth.
	 */
	tokenTemplate: z.string().optional(),
	/** Header used by generated REST tools unless overridden at tool level. */
	authHeader: z.string().optional(),
	/** Header value template used by generated REST tools. */
	authTemplate: z.string().optional(),
	/** Optional transform applied before inserting the token into authTemplate. */
	authEncoding: z.enum(["base64"]).optional(),
	/** Operator-facing hint shown in connection UIs. */
	helpText: z.string().optional(),
	/** OAuth scope groups used for reconnect prompts and capability checks. */
	scopeGroups: z.array(ConnectionCredentialScopeGroupSchema).optional(),
	/** Default scopes to request when provisioning OAuth outbound apps. */
	defaultScopes: z.array(z.string()).optional(),
});

export type ConnectionCredentialProfile = z.infer<
	typeof ConnectionCredentialProfileSchema
>;

// =============================================================================
// CONNECTION PROVIDER SCHEMAS
// =============================================================================

export const ConnectionProviderSchema = z.object({
	/** Descope outbound app ID */
	appId: z.string(),
	/** Display name (e.g. "GitHub", "Slack", "Google Drive") */
	name: z.string(),
	/** Provider description */
	description: z.string().nullable(),
	/** Whether the provider is enabled for this org */
	enabled: z.boolean(),
	/** OAuth scopes available for this provider */
	availableScopes: z.array(z.string()),
	/** Logo URL for the provider */
	logoUrl: z.string().nullable(),
	/** Connection type: oauth (redirect flow) or api_key (Descope flow with input form) */
	connectionType: z.enum(["oauth", "api_key"]),
	/** OAuth client registration path. CIMD uses Tedix's native callback; other OAuth stays Descope-managed. */
	registrationMode: z
		.enum(["cimd", "dcr", "pre_registered", "invalid"])
		.nullable()
		.describe(
			"Null for API-key providers; OAuth mode selects the native CIMD callback or the Descope-managed compatibility path.",
		),
	/** Token scope: "tenant" (org-shared) or "user" (per-user personal credential) */
	tokenScope: z.enum(["tenant", "user"]),
	/** Which credential scopes this provider supports */
	supportedScopes: z.array(z.enum(["tenant", "user"])),
	/** Default scope for new connections */
	recommendedScope: z.enum(["tenant", "user"]),
	/** Provider-specific API-key input shape, auth injection defaults, and OAuth scope groups. */
	credentialProfile: ConnectionCredentialProfileSchema.nullable().optional(),
	/**
	 * Whether any app in the current org references this provider — either via
	 * `app.metadata.mcpConfig.connectionProviderId` (catalog fork default) or via
	 * a tool's `config.auth.connectionId`. Lets an operator UI surface the small
	 * set of providers the org actually uses ahead of the full project-wide list.
	 */
	referencedByOrg: z.boolean().default(false),
});

export type ConnectionProvider = z.infer<typeof ConnectionProviderSchema>;

export const UserConnectionSchema = z.object({
	/** Descope outbound app ID */
	appId: z.string(),
	/** Provider display name */
	providerName: z.string(),
	/** Connection status */
	status: z.enum(["connected", "expired", "revoked"]),
	/** When the connection was established (unix seconds) */
	connectedAt: z.number().nullable(),
	/** Token expiration (unix seconds), if known */
	tokenExpiresAt: z.number().nullable(),
	/** Granted OAuth scopes */
	scopes: z.array(z.string()),
	/** Credential scope: "tenant" (org-shared) or "user" (personal) */
	tokenScope: z.enum(["tenant", "user"]),
	/** Descope userId of who established this connection */
	connectedByUserId: z.string().nullable().optional(),
	/** Email of who established this connection */
	connectedByEmail: z.string().nullable().optional(),
});

export type UserConnection = z.infer<typeof UserConnectionSchema>;

export const ConnectionProviderConfigSchema = z.object({
	/** Optional custom ID — set during creation only, immutable after */
	id: z.string().min(1).max(100).optional(),
	name: z.string().min(1).max(100),
	description: z.string().max(254).optional(),
	logo: z.url().optional(),
	type: z.enum(["oauth", "api_key"]),
	clientId: z.string().optional(),
	clientSecret: z.string().optional(),
	authorizationUrl: z.url().optional(),
	/** Additional query params appended to the authorization request */
	authorizationUrlParams: z.array(UrlParamSchema).optional(),
	tokenUrl: z.url().optional(),
	/** Additional query params appended to the token exchange request */
	tokenUrlParams: z.array(UrlParamSchema).optional(),
	/** OAuth token revocation endpoint */
	revocationUrl: z.url().optional(),
	discoveryUrl: z.url().optional(),
	pkce: z.boolean().optional(),
	defaultScopes: z.array(z.string()).optional(),
	/** Default redirect URL after successful OAuth flow */
	defaultRedirectUrl: z.url().optional(),
	/** Domain to use for OAuth callbacks (defaults to project domain) */
	callbackDomain: z.string().optional(),
	/** OAuth access type — "offline" requests a refresh token */
	accessType: z.enum(["offline", "online"]).optional(),
	/** OAuth prompt parameters */
	prompt: z
		.array(z.enum(["none", "login", "consent", "select_account"]))
		.optional(),
	/** Enable Dynamic Client Registration (DCR) — provider auto-registers Descope as an OAuth client */
	useDcr: z.boolean().optional(),
	/** DCR registration endpoint URL (required when useDcr is true) */
	dcrUrl: z.url().optional(),
	/** Tedix-side credential shape and scope metadata for this provider. */
	credentialProfile: ConnectionCredentialProfileSchema.optional(),
});

export type ConnectionProviderConfig = z.infer<
	typeof ConnectionProviderConfigSchema
>;

export const CreateProviderFromMcpInputSchema = z.object({
	/** Optional stable Descope outbound app ID. Defaults to the catalog app slug when a catalog app is used. */
	id: z.string().min(1).max(100).optional(),
	/**
	 * Base Tedix provider template to copy credential profile, supported token
	 * scopes, and recommended token scope from when provisioning a project-specific
	 * outbound app id. Example: id="promptwatch-tedix",
	 * baseProviderId="promptwatch-api-key".
	 */
	baseProviderId: z.string().min(1).max(100).optional(),
	/** Catalog app UUID to derive name/logo/endpoint from. */
	catalogAppId: z.string().uuid().optional(),
	/** Catalog app slug to derive name/logo/endpoint from. */
	catalogAppSlug: z.string().min(1).max(100).optional(),
	/** Upstream MCP server URL. Optional when catalogAppId or catalogAppSlug is provided. */
	mcpEndpointUrl: z.string().url().optional(),
	name: z.string().min(1).max(100).optional(),
	description: z.string().max(500).optional(),
	logo: z.string().url().optional(),
	/** Provider kind to create. Auto uses catalog authTypes when available, otherwise OAuth metadata discovery. */
	connectionType: z
		.enum(["auto", "oauth", "api_key"])
		.default("auto")
		.optional(),
	/** Requested default scopes. If omitted, uses the protected resource's scopes_supported. */
	defaultScopes: z.array(z.string()).optional(),
	/**
	 * Required provider scopes for generated tool calls. For OAuth providers this
	 * also seeds defaultScopes unless defaultScopes is set explicitly.
	 */
	connectionScopes: z.array(z.string()).optional(),
	/** Recommended Token Vault scope for generated app/tool metadata. */
	connectionScope: z.enum(["tenant", "user", "hybrid"]).optional(),
	/** Include RFC 8707 resource parameter in auth/token requests. Defaults to true for MCP protected resources. */
	includeResourceParameter: z.boolean().default(true).optional(),
	/** Update an existing outbound app with the same id instead of failing. Defaults to true for catalog provisioning. */
	upsertExisting: z.boolean().default(true).optional(),
	/**
	 * Existing static OAuth clients are preserved by default so stored client
	 * secrets/tokens are not rotated accidentally. Use migrate_to_dcr only for
	 * an intentional operator-led migration to Descope-managed DCR. Use
	 * re_register_static to replace a broken DCR client with a Tedix-registered
	 * static client whose redirect URI exactly matches the custom auth domain.
	 */
	staticOAuthClientPolicy: z
		.enum(["preserve", "migrate_to_dcr", "re_register_static"])
		.default("preserve")
		.optional(),
	/** Resolve metadata and return the Descope payload without creating the outbound app. */
	dryRun: z.boolean().default(false).optional(),
});

export type CreateProviderFromMcpInput = z.infer<
	typeof CreateProviderFromMcpInputSchema
>;

export const McpConnectionDiscoverySchema = z.object({
	mcpEndpointUrl: z.string().url(),
	// Null when the server publishes no RFC 9728 protected-resource metadata and
	// discovery fell back to RFC 8414 authorization-server metadata directly.
	protectedResourceMetadataUrl: z.string().url().nullable(),
	resource: z.string().url(),
	authorizationServer: z.string().url(),
	authorizationServerMetadataUrl: z.string().url(),
	authorizationUrl: z.string().url(),
	tokenUrl: z.string().url(),
	revocationUrl: z.string().url().nullable(),
	registrationMode: z.enum(["cimd", "dcr"]),
	clientIdMetadataDocumentSupported: z.boolean(),
	dcrUrl: z
		.string()
		.url()
		.nullable()
		.describe(
			"Null for CIMD clients because their HTTPS client_id replaces per-issuer Dynamic Client Registration; required only for the measured DCR compatibility mode.",
		),
	scopesSupported: z.array(z.string()),
	authorizationServerScopesSupported: z.array(z.string()),
	codeChallengeMethodsSupported: z.array(z.string()),
	tokenEndpointAuthMethodsSupported: z.array(z.string()),
	// RFC 9207: AS metadata `authorization_response_iss_parameter_supported`.
	authorizationResponseIssParameterSupported: z.boolean(),
});

export const CreateProviderFromMcpOutputSchema = z.object({
	dryRun: z.boolean(),
	created: z.boolean(),
	status: z.enum(["dry_run", "created", "updated"]),
	appId: z.string(),
	name: z.string(),
	config: ConnectionProviderConfigSchema,
	provisioning: z.object({
		/** Descope outbound app ID to write into app metadata/tool auth config. */
		connectionProviderId: z.string(),
		/** Base Tedix provider template used for credential profile and scope defaults. */
		baseProviderId: z.string().nullable(),
		connectionType: z.enum(["oauth", "api_key"]),
		supportedScopes: z.array(z.enum(["tenant", "user"])),
		recommendedScope: z.enum(["tenant", "user"]),
		/** Concrete Token Vault scope recommended for this catalog app. */
		connectionScope: z.enum(["tenant", "user", "hybrid"]),
		/** Required OAuth/API scopes to copy into generated tool auth config. */
		connectionScopes: z.array(z.string()).optional(),
		credentialProfile: ConnectionCredentialProfileSchema.nullable().optional(),
		mcpConfig: z.object({
			connectionProviderId: z.string(),
			connectionScope: z.enum(["tenant", "user", "hybrid"]),
			connectionScopes: z.array(z.string()).optional(),
		}),
	}),
	discovery: McpConnectionDiscoverySchema.nullable(),
	warnings: z.array(z.string()),
});

export type CreateProviderFromMcpOutput = z.infer<
	typeof CreateProviderFromMcpOutputSchema
>;

export const AuditConnectionProviderSettingsInputSchema = z
	.object({
		/** Fetch MCP/OAuth metadata and compare live Descope settings to upstream provider metadata. */
		checkDiscovery: z.boolean().default(true).optional(),
		/** Include providers that are not currently referenced by this org's apps/tools. */
		includeUnreferenced: z.boolean().default(true).optional(),
	})
	.optional();

export const ConnectionProviderAuditIssueSchema = z.object({
	severity: z.enum(["critical", "warning", "info"]),
	code: z.string(),
	appId: z.string(),
	message: z.string(),
	details: z.record(z.string(), JsonValueSchema).optional(),
});

export type ConnectionProviderAuditIssue = z.infer<
	typeof ConnectionProviderAuditIssueSchema
>;

export const ConnectionProviderAuditAppSchema = z.object({
	appId: z.string(),
	name: z.string(),
	appType: z.string().nullable(),
	connectionType: z.enum(["oauth", "api_key"]),
	referencedByOrg: z.boolean(),
	logoKind: z.enum(["data", "url", "missing", "invalid"]),
	tokenScope: z.enum(["tenant", "user"]),
	supportedScopes: z.array(z.enum(["tenant", "user"])),
	recommendedScope: z.enum(["tenant", "user"]),
	settings: z.object({
		registrationMode: z
			.enum(["cimd", "dcr", "pre_registered", "invalid"])
			.nullable()
			.describe(
				"Observed OAuth client registration mode; null for API-key providers.",
			),
		useDcr: z.boolean().nullable(),
		dcrUrl: z.string().nullable(),
		hasClientId: z.boolean(),
		authorizationUrl: z.string().nullable(),
		tokenUrl: z.string().nullable(),
		revocationUrl: z.string().nullable(),
		pkce: z.boolean().nullable(),
		defaultScopes: z.array(z.string()),
		resourceParameter: z.string().nullable(),
		tokenResourceParameter: z.string().nullable(),
	}),
	discovery: z
		.object({
			protectedResourceMetadataUrl: z.string().nullable(),
			authorizationServerMetadataUrl: z.string().nullable(),
			resource: z.string().nullable(),
			authorizationServer: z.string().nullable(),
			authorizationUrl: z.string().nullable(),
			tokenUrl: z.string().nullable(),
			revocationUrl: z.string().nullable(),
			dcrUrl: z.string().nullable(),
			scopesSupported: z.array(z.string()),
			authorizationServerScopesSupported: z.array(z.string()),
			codeChallengeMethodsSupported: z.array(z.string()),
			tokenEndpointAuthMethodsSupported: z.array(z.string()),
			error: z.string().nullable(),
		})
		.nullable(),
	issues: z.array(ConnectionProviderAuditIssueSchema),
});

export const AuditConnectionProviderSettingsOutputSchema = z.object({
	checkedAt: z.string(),
	summary: z.object({
		total: z.number(),
		oauth: z.number(),
		apiKey: z.number(),
		critical: z.number(),
		warning: z.number(),
		info: z.number(),
		ok: z.number(),
	}),
	issues: z.array(ConnectionProviderAuditIssueSchema),
	apps: z.array(ConnectionProviderAuditAppSchema),
});

export type AuditConnectionProviderSettingsInput = z.infer<
	typeof AuditConnectionProviderSettingsInputSchema
>;
export type AuditConnectionProviderSettingsOutput = z.infer<
	typeof AuditConnectionProviderSettingsOutputSchema
>;

/** Credential state is independent of installation, assignment and provider health. */
export const ConnectionAccountStateSchema = z.enum([
	"present",
	"missing",
	"expired",
	"restricted",
	"unknown",
]);
export const ConnectionInventoryInputSchema = z
	.object({
		scope: z.enum(["organization", "personal"]).default("organization"),
		q: z.string().max(200).default(""),
		providerId: z
			.string()
			.min(1)
			.max(200)
			.optional()
			.describe(
				"Omit to list relevant accounts; provide an ID to inspect a catalog provider explicitly.",
			),
		status: z.enum(["all", "attention", "in_use", "unused"]).default("all"),
		limit: z.number().int().min(1).max(100).default(50),
		offset: z.number().int().min(0).default(0),
	})
	.strict();
export const ConnectionReferenceSchema = z.object({
	appId: z.string(),
	appSlug: z.string(),
	source: z.enum(["app", "tool", "aggregate"]),
});
export const ConnectionInventoryRowSchema = z.object({
	provider: ConnectionProviderSchema,
	connectionInstanceId: z.uuid().optional(),
	instanceLabel: z.string().optional(),
	scope: z.enum(["tenant", "user"]),
	accountState: ConnectionAccountStateSchema,
	accountLabel: z
		.string()
		.nullable()
		.describe(
			"Current credential owner label when known; null does not identify an external provider account.",
		),
	connection: UserConnectionSchema.nullable().describe(
		"Credential metadata only when a token was observed; null may mean missing, restricted, or unknown, as accountState specifies.",
	),
	references: z.array(ConnectionReferenceSchema),
	/** Direct, same-provider apps that can bind this slot; not proof of a binding. */
	bindingTargets: z.array(ConnectionReferenceSchema).optional(),
	referencesComplete: z.boolean(),
	access: z.literal("not_evaluated"),
	health: z.literal("not_checked"),
});
export const ConnectionInventorySchema = z.object({
	organizationId: z.string(),
	scope: z.enum(["organization", "personal"]),
	observedAt: z.string(),
	rows: z.array(ConnectionInventoryRowSchema),
	total: z.number().int().nonnegative(),
	hasMore: z.boolean(),
	verificationComplete: z.boolean(),
	referencesComplete: z.boolean(),
	issues: z.array(
		z.object({
			source: z.enum(["credentials", "references"]),
			message: z.string(),
		}),
	),
});
export type ConnectionInventoryInput = z.infer<
	typeof ConnectionInventoryInputSchema
>;
export type ConnectionInventory = z.infer<typeof ConnectionInventorySchema>;
export type ConnectionInventoryRow = z.infer<
	typeof ConnectionInventoryRowSchema
>;
