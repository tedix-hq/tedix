/**
 * Connection Provider Template Schemas
 *
 * Shape for the D1-backed `connection_providers` table: pre-built OAuth/api_key
 * connection templates (Google Gmail, GitHub, Slack, ...) that decorate live
 * Descope outbound apps with display metadata, scope defaults, and credential
 * templates. Descope is the source of truth for what's registered; this table
 * only supplies defaults/metadata for provider ids it recognizes — a provider
 * can be created and connected without a row here (see
 * `connections.createProvider`, which takes fully explicit params).
 *
 * Reuses `ConnectionCredentialFieldSchema`/`ConnectionCredentialProfileSchema`
 * from ./connections.ts (the same shape used by the live `listProviders`
 * response) via `z.input<>` rather than `z.infer<>`, since those schemas apply
 * `.default(...)` at parse time — a default we don't want baked into the
 * *stored* template shape, only applied (if at all) when a template is
 * actually served to a client.
 */

import * as z from "zod";
import {
	type ConnectionCredentialFieldSchema,
	ConnectionCredentialProfileSchema,
	type ConnectionCredentialScopeGroupSchema,
} from "./connections";

export type ConnectionCredentialField = z.input<
	typeof ConnectionCredentialFieldSchema
>;
export type ConnectionCredentialScopeGroup = z.input<
	typeof ConnectionCredentialScopeGroupSchema
>;
export type ConnectionCredentialProfile = z.input<
	typeof ConnectionCredentialProfileSchema
>;

export const TokenScopeSchema = z.enum(["tenant", "user"]);
export type TokenScope = z.infer<typeof TokenScopeSchema>;

export const ConnectionProviderCategorySchema = z.enum([
	"productivity",
	"development",
	"crm",
	"communication",
	"storage",
	"analytics",
	"commerce",
	"finance",
	"infrastructure",
]);
export type ConnectionProviderCategory = z.infer<
	typeof ConnectionProviderCategorySchema
>;

const OAuthUrlParamSchema = z.object({
	key: z.string(),
	value: z.string(),
});

export const ConnectionProviderOAuthConfigSchema = z.object({
	authorizationUrl: z.string(),
	authorizationUrlParams: z.array(OAuthUrlParamSchema).optional(),
	tokenUrl: z.string(),
	tokenUrlParams: z.array(OAuthUrlParamSchema).optional(),
	discoveryUrl: z.string().optional(),
	pkce: z.boolean().optional(),
	useDcr: z.boolean().optional(),
	dcrUrl: z.string().optional(),
	callbackDomain: z.string().optional(),
	accessType: z.enum(["offline", "online"]).optional(),
	prompt: z
		.array(z.enum(["none", "login", "consent", "select_account"]))
		.optional(),
});
export type ConnectionProviderOAuthConfig = z.input<
	typeof ConnectionProviderOAuthConfigSchema
>;

/**
 * A pre-built connection provider template backed by the canonical
 * `connection_providers` D1 table.
 */
export const ConnectionProviderTemplateSchema = z.object({
	/** Unique provider identifier (e.g. "google-sheets", "github") */
	id: z.string().min(1),
	/** Display name */
	name: z.string().min(1),
	/** Short description of what the provider enables */
	description: z.string(),
	/** Icon identifier or URL */
	icon: z.string(),
	/** Provider category for grouping in the UI */
	category: ConnectionProviderCategorySchema,
	/** Connection type: OAuth for browser-based auth, api_key for static secrets */
	type: z.enum(["oauth", "api_key"]),
	/** Default OAuth scopes to request */
	requiredScopes: z.array(z.string()),
	/** Which credential scopes this provider supports */
	supportedScopes: z.array(TokenScopeSchema),
	/** Default scope for new connections */
	recommendedScope: TokenScopeSchema,
	/** Descope outbound app ID, set after registration in Descope console */
	descopeAppId: z.string().optional(),
	/** Additional Descope outbound app IDs that reuse this provider definition */
	descopeAppAliases: z.array(z.string()).optional(),
	/** Provider-specific credential shape and OAuth scope metadata */
	credentialProfile: ConnectionCredentialProfileSchema.optional(),
	/** OAuth endpoint config for programmatic provider creation */
	oauthConfig: ConnectionProviderOAuthConfigSchema.optional(),
	/**
	 * ADR tedi-client-oauth-cimd phase 1a: RFC 8414-validated authorization-
	 * server issuer pinned at first successful MCP OAuth discovery. Absent on
	 * legacy/never-discovered providers.
	 */
	pinnedIssuer: z.string().optional(),
	/**
	 * RFC 9207 `authorization_response_iss_parameter_supported` recorded from
	 * AS metadata at pin time. Feeds `assertAuthorizationResponseIss` so the
	 * strict absent-iss branch applies wherever this flag was previously
	 * unknown. Absent = unknown (legacy row).
	 */
	authorizationResponseIssSupported: z.boolean().optional(),
});
export type ConnectionProviderTemplate = z.input<
	typeof ConnectionProviderTemplateSchema
>;
