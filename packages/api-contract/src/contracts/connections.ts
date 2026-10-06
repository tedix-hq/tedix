import { JsonValueSchema } from "../schemas/common";
import "@orpc/openapi/extensions/route";
/**
 * Connections Contract for oRPC
 * Manages OAuth connection providers and user connections via Descope Outbound Apps
 *
 * Auth: User JWT (OS) or API Key with integrations:manage scope
 * All endpoints are org-scoped via JWT context
 */

import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import {
	ConnectionInventoryInputSchema,
	ConnectionInventorySchema,
	AuditConnectionProviderSettingsInputSchema,
	AuditConnectionProviderSettingsOutputSchema,
	ConnectionProviderConfigSchema,
	ConnectionProviderSchema,
	CreateProviderFromMcpInputSchema,
	CreateProviderFromMcpOutputSchema,
	UserConnectionSchema,
} from "../schemas/connections";
import {
	destructiveAuditReason,
	StatelessDestructiveConfirmationShape,
} from "./cognitive";

// =============================================================================
// CONTRACT
// =============================================================================

export const connectionsContract = oc
	.route({ tags: ["connections"], prefix: "/connections" })
	.errors(baseErrors)
	.router({
		createConnectionInstance: oc
			.route({
				method: "POST",
				path: "/instances",
				summary: "Add account",
			})
			.input(
				z.object({
					appId: z.string().min(1),
					scope: z.enum(["tenant", "user"]).default("user"),
					label: z.string().trim().min(1).max(100),
				}),
			)
			.output(z.object({ id: z.uuid(), appId: z.string(), label: z.string() })),
		renameConnectionInstance: oc
			.route({
				method: "PATCH",
				path: "/instances/{id}",
				summary: "Rename account",
			})
			.input(
				z.object({
					id: z.uuid(),
					label: z.string().trim().min(1).max(100),
					scope: z.enum(["tenant", "user"]).default("user"),
				}),
			)
			.output(z.object({ success: z.literal(true) })),
		preparePersonalConnection: oc
			.route({
				method: "POST",
				path: "/instances/prepare",
				summary: "Authorize account handoff",
			})
			.input(
				z.object({
					appId: z.string().min(1),
					scope: z.enum(["tenant", "user"]).default("user"),
					connectionInstanceId: z.uuid(),
					scopes: z.array(z.string()).optional(),
				}),
			)
			.output(
				z.object({
					externalIdentifier: z.string(),
					userId: z.string(),
					scopes: z.array(z.string()),
				}),
			),
		bindConnectionInstance: oc
			.route({
				method: "POST",
				path: "/instances/bind",
				summary: "Select account for app",
			})
			.input(
				z.object({
					appId: z.uuid(),
					providerId: z.string().min(1),
					scope: z.enum(["tenant", "user"]).default("user"),
					connectionInstanceId: z.uuid(),
				}),
			)
			.output(z.object({ success: z.literal(true) })),
		getConnectionsOverview: oc
			.route({
				method: "GET",
				path: "/overview",
				summary: "Get connections overview",
				description:
					"Inspect organization or personal accounts, app references, missing credentials and verification failures. Installation, credential presence, assignment and health are separate facts. Never returns secrets.",
			})
			.input(ConnectionInventoryInputSchema)
			.output(ConnectionInventorySchema),
		/**
		 * List available connection providers for the organization
		 * GET /connections/providers
		 */
		listProviders: oc
			.route({
				method: "GET",
				path: "/providers",
				summary: "List connection providers",
				description:
					"List all available OAuth connection providers configured for the organization",
			})
			.input(z.object({}).optional())
			.output(
				z.object({
					data: z.array(ConnectionProviderSchema),
				}),
			),

		/**
		 * Audit Descope outbound app settings against Tedix provider metadata and
		 * upstream MCP/OAuth discovery documents.
		 * GET /connections/providers/audit
		 */
		auditProviderSettings: oc
			.route({
				method: "GET",
				path: "/providers/audit",
				tags: ["internal"],
				summary: "Audit connection provider settings",
				description:
					"Validate Descope outbound app settings against Tedix provider metadata and upstream MCP/OAuth discovery metadata.",
			})
			.input(AuditConnectionProviderSettingsInputSchema)
			.output(AuditConnectionProviderSettingsOutputSchema),

		/**
		 * List a user's active connections
		 * GET /connections/me
		 */
		getUserConnections: oc
			.route({
				method: "GET",
				path: "/me",
				summary: "List user connections",
				description:
					"List all active OAuth connections for the authenticated user",
			})
			.input(z.object({}).optional())
			.output(
				z.object({
					data: z.array(UserConnectionSchema),
				}),
			),

		/**
		 * Initiate an OAuth connection flow
		 * POST /connections/connect
		 * Returns a redirect URL to start the OAuth flow
		 */
		initiateConnection: oc
			.route({
				method: "POST",
				path: "/connect",
				summary: "Initiate OAuth connection",
				description:
					"Start an OAuth connection flow with a provider. Returns a redirect URL.",
			})
			.input(
				z.object({
					/** Descope outbound app ID to connect to */
					appId: z.string().min(1),
					/** Requested OAuth scopes (space-separated string or array) */
					scopes: z.union([z.string(), z.array(z.string())]).optional(),
					/** Callback URL after OAuth flow completes */
					redirectUri: z.url().optional(),
				}),
			)
			.output(
				z.object({
					/** URL to redirect the user to for OAuth authorization */
					redirectUrl: z.url(),
					/** State parameter for CSRF protection */
					state: z.string(),
				}),
			),

		/**
		 * Disconnect a user's connection to a provider
		 * DELETE /connections/{appId}
		 */
		disconnectProvider: oc
			.route({
				method: "DELETE",
				path: "/{appId}",
				summary: "Disconnect provider",
				description:
					"Remove either an organization-level or personal OAuth connection to a provider.",
				successStatus: 200,
			})
			.input(
				z.object({
					...StatelessDestructiveConfirmationShape,
					reason: destructiveAuditReason(
						"Audit reason for the confirmed provider disconnect",
					),
					appId: z.string().min(1),
					/** The exact credential scope to disconnect. */
					tokenScope: z.enum(["tenant", "user"]),
					connectionInstanceId: z.uuid().optional(),
				}),
			)
			.output(
				z.object({
					success: z.literal(true),
					message: z.string(),
				}),
			),

		/**
		 * Fetch a connection token on behalf of a tedi
		 * POST /connections/tedi-token
		 *
		 * Auth: tk_ access key or service token
		 * Uses scope-aware token retrieval from Descope Token Vault.
		 */
		fetchTediToken: oc
			.route({
				method: "POST",
				path: "/tedi-token",
				tags: ["internal"],
				summary: "Fetch provider token for tedi",
				description:
					"Retrieve an OAuth access token for a connected provider on behalf of a tedi. Supports tenant, user, or hybrid credential resolution from Descope Token Vault.",
			})
			.input(
				z.object({
					/** Tedi ID requesting the token */
					tediId: z.uuid(),
					delegatedToolUse: z
						.object({ appId: z.uuid(), arguments: JsonValueSchema })
						.strict()
						.optional(),
					connectionInstanceId: z.uuid().optional(),
					/** Descope outbound app ID for the provider */
					providerId: z.string().min(1),
					/** Optional scopes to request */
					scopes: z.array(z.string()).optional(),
					/** Token scope: "tenant" (org-shared, default), "user" (caller/owner personal credential), or "hybrid" (user first, then tenant). */
					scope: z.enum(["tenant", "user", "hybrid"]).default("tenant"),
					/** Hybrid lookup order. Defaults to user-first. */
					preference: z.enum(["user-first", "tenant-first"]).optional(),
					/** Calling user's Descope userId — enables per-user credential resolution */
					userId: z.string().optional(),
				}),
			)
			.output(
				z.object({
					/** OAuth access token */
					accessToken: z.string(),
					/** Token expiration timestamp (unix seconds), if available */
					expiresAt: z.number().optional(),
					/** OAuth scopes granted */
					scopes: z.array(z.string()).optional(),
				}),
			),

		/**
		 * Fetch a connection token at the org/tenant level — no tedi proxy required.
		 * POST /connections/org-token
		 *
		 * Use when the caller is a human user (or any non-tedi context). This is
		 * the abridged version of fetchTediToken without the owner-personal hop,
		 * so it works even for orgs that haven't created a tedi yet.
		 *
		 * Auth: any standard auth path. Caller's organizationId must match the
		 * input organizationId (or platform-admin override).
		 */
		fetchOrgToken: oc
			.route({
				method: "POST",
				path: "/org-token",
				tags: ["internal"],
				summary: "Fetch provider token for org/tenant",
				description:
					"Scope-aware credential lookup that doesn't require a tedi. Defaults to tenant-scoped credentials and supports user or hybrid lookup when requested.",
			})
			.input(
				z.object({
					/**
					 * Target organization. Accepts either D1 UUID or Descope tenant id
					 * shape (`org_<slug>`, `personal_<id>`, `T<id>`) — the MCP edge
					 * passes JWT tenant claims verbatim and they're Descope-shaped for
					 * human OAuth users. Server translates either form to the canonical
					 * D1 UUID before resolution.
					 */
					organizationId: z.string().min(1),
					connectionInstanceId: z.uuid().optional(),
					/** Descope outbound app ID for the provider */
					providerId: z.string().min(1),
					/** Optional scopes to request */
					scopes: z.array(z.string()).optional(),
					/** Token scope: "tenant" (org-shared, default), "user" (caller personal credential), or "hybrid" (user first, then tenant). */
					scope: z.enum(["tenant", "user", "hybrid"]).default("tenant"),
					/** Hybrid lookup order. Defaults to user-first. */
					preference: z.enum(["user-first", "tenant-first"]).optional(),
					/** Calling user's Descope userId — enables per-user credential resolution */
					userId: z.string().optional(),
					/**
					 * Optional connection label (e.g. per-project routing hint from
					 * X-Tedix-Connection-Label). When set, the label-scoped credential
					 * (project-specific outbound app such as `promptwatch-{label}`) is
					 * preferred; resolution falls back to the default provider
					 * credential when no labeled credential exists.
					 */
					label: z.string().min(1).max(64).optional(),
				}),
			)
			.output(
				z.object({
					accessToken: z.string(),
					expiresAt: z.number().optional(),
					scopes: z.array(z.string()).optional(),
				}),
			),

		/**
		 * List connections available to a tedi
		 * GET /connections/tedi/{tediId}
		 *
		 * Auth: tk_ access key or service token
		 * Lists providers with tenant-scoped connection status
		 */
		getTediConnections: oc
			.route({
				method: "GET",
				path: "/tedi/{tediId}",
				summary: "List tedi connections",
				description:
					"List available OAuth connections for a tedi based on its organization's configured providers and tenant-scoped tokens",
			})
			.input(
				z.object({
					tediId: z.uuid(),
				}),
			)
			.output(
				z.object({
					data: z.array(UserConnectionSchema),
				}),
			),

		/**
		 * Fetch a fresh access token for a connected provider
		 * POST /connections/fetch-token
		 *
		 * Calls Descope's outboundApplication.fetchToken() to retrieve a current
		 * OAuth access token for the specified provider. Descope handles refresh
		 * token rotation automatically.
		 */
		fetchToken: oc
			.route({
				method: "POST",
				path: "/fetch-token",
				tags: ["internal"],
				summary: "Fetch provider access token",
				description:
					"Retrieve a fresh OAuth access token for a connected provider. Descope handles token refresh automatically.",
			})
			.input(
				z.object({
					/** Descope outbound app ID for the provider */
					providerId: z.string().min(1),
					/** Optional scopes to request (uses provider defaults if omitted) */
					scopes: z.array(z.string()).optional(),
				}),
			)
			.output(
				z.object({
					/** OAuth access token */
					accessToken: z.string(),
					/** Token expiration timestamp (unix seconds), if available */
					expiresAt: z.number().optional(),
					/** OAuth scopes granted */
					scopes: z.array(z.string()).optional(),
				}),
			),

		/**
		 * Store an API key for a connection provider
		 * POST /connections/store-api-key
		 *
		 * Stores credentials in Descope AIH Token Vault. Use project-specific
		 * outbound app IDs for multiple credentials of the same upstream service.
		 */
		storeApiKey: oc
			.route({
				method: "POST",
				path: "/store-api-key",
				summary: "Store API key for provider",
				description:
					"Store an API key credential for a connection provider that uses key-based authentication instead of OAuth. Credentials are uploaded to Descope AIH Token Vault.",
			})
			.input(
				z
					.object({
						/** Descope outbound app ID for the provider */
						providerId: z.string().min(1),
						/** Opaque API key value to store when the provider has a single field. */
						apiKey: z.string().min(1).optional(),
						/**
						 * Provider-specific field values. The API composes these into the
						 * exact opaque value stored in Descope Token Vault using the
						 * provider credential profile.
						 */
						credentialFields: z.record(z.string(), z.string()).optional(),
						/** Credential scope: "tenant" (org-shared, default) or "user" (personal) */
						tokenScope: z.enum(["tenant", "user"]).default("tenant").optional(),
					})
					.refine(
						(input) =>
							!!input.apiKey?.trim() ||
							Object.values(input.credentialFields ?? {}).some((value) =>
								value.trim(),
							),
						{
							message: "Either apiKey or credentialFields is required",
							path: ["apiKey"],
						},
					),
			)
			.output(
				z.object({
					success: z.literal(true),
					message: z.string(),
				}),
			),

		/**
		 * Create a new connection provider for the organization
		 * POST /connections/providers
		 */
		createProvider: oc
			.route({
				method: "POST",
				path: "/providers",
				summary: "Create connection provider",
				description:
					"Create a new OAuth or API key connection provider for the organization via Descope Outbound Apps",
			})
			.input(ConnectionProviderConfigSchema)
			.output(
				z.object({
					appId: z.string(),
					name: z.string(),
				}),
			),

		/**
		 * Create a Descope outbound app from an upstream MCP protected resource.
		 * POST /connections/providers/from-mcp
		 */
		createProviderFromMcp: oc
			.route({
				method: "POST",
				path: "/providers/from-mcp",
				summary: "Create connection provider from MCP endpoint",
				description:
					"Discover OAuth protected-resource and authorization-server metadata from an upstream MCP server, derive the DCR registration endpoint, and create a Descope outbound app.",
			})
			.input(CreateProviderFromMcpInputSchema)
			.output(CreateProviderFromMcpOutputSchema),

		/**
		 * Update non-secret Descope outbound app metadata and OAuth scope defaults.
		 * PATCH /connections/providers/{appId}/metadata
		 */
		updateProviderMetadata: oc
			.route({
				method: "PATCH",
				path: "/providers/{appId}/metadata",
				summary: "Update connection provider metadata",
				description:
					"Update display metadata or default OAuth scopes for an existing Descope outbound app without touching OAuth clients, DCR settings, or stored tokens.",
			})
			.input(
				z
					.object({
						/** Descope outbound app ID */
						appId: z.string().min(1),
						/** Human-readable provider name */
						name: z.string().min(1).max(100).optional(),
						/** Provider description */
						description: z.string().max(254).optional(),
						/** Provider logo URL */
						logo: z.url().optional(),
						/** Default OAuth scopes requested by Descope consent */
						defaultScopes: z.array(z.string().min(1)).optional(),
					})
					.refine(
						(input) =>
							input.name !== undefined ||
							input.description !== undefined ||
							input.logo !== undefined ||
							input.defaultScopes !== undefined,
						{
							message:
								"At least one provider field is required: name, description, logo, or defaultScopes",
							path: ["defaultScopes"],
						},
					),
			)
			.output(
				z.object({
					appId: z.string(),
					success: z.literal(true),
				}),
			),

		/**
		 * Delete a connection provider from the organization
		 * DELETE /connections/providers/{appId}
		 */
		deleteProvider: oc
			.route({
				method: "DELETE",
				path: "/providers/{appId}",
				summary: "Delete connection provider",
				description:
					"Remove a connection provider and all associated connections from the organization",
				successStatus: 200,
			})
			.input(
				z.object({
					...StatelessDestructiveConfirmationShape,
					reason: destructiveAuditReason(
						"Audit reason for the confirmed provider deletion",
					),
					appId: z.string().min(1),
				}),
			)
			.output(
				z.object({
					success: z.literal(true),
					message: z.string(),
				}),
			),

		/**
		 * Create a connection provider scoped to a specific tedi
		 * POST /connections/tedi/{tediId}/providers
		 */
		createTediProvider: oc
			.route({
				method: "POST",
				path: "/tedi/{tediId}/providers",
				summary: "Create tedi-scoped connection provider",
				description:
					"Create a new OAuth or API key connection provider scoped to a specific tedi within the organization",
			})
			.input(
				z
					.object({
						tediId: z.uuid(),
					})
					.extend(ConnectionProviderConfigSchema.shape),
			)
			.output(
				z.object({
					appId: z.string(),
					name: z.string(),
				}),
			),

		/**
		 * Store an API key for a tedi-scoped connection provider
		 * POST /connections/tedi/{tediId}/store-api-key
		 */
		storeTediApiKey: oc
			.route({
				method: "POST",
				path: "/tedi/{tediId}/store-api-key",
				summary: "Store API key for tedi provider",
				description:
					"Store a tenant-scoped API key credential for a tedi connection provider in Descope AIH Token Vault. Provider-specific credentialFields are composed with the same opaque-token template as the org/user path.",
			})
			.input(
				z
					.object({
						tediId: z.uuid(),
						/** Descope outbound app ID for the provider */
						providerId: z.string().min(1),
						/** Opaque API key value to store when the provider has a single field. */
						apiKey: z.string().min(1).optional(),
						/**
						 * Provider-specific field values. The API composes these into the
						 * exact opaque value stored in Descope Token Vault using the
						 * provider credential profile.
						 */
						credentialFields: z.record(z.string(), z.string()).optional(),
					})
					.refine(
						(input) =>
							!!input.apiKey?.trim() ||
							Object.values(input.credentialFields ?? {}).some((value) =>
								value.trim(),
							),
						{
							message: "Either apiKey or credentialFields is required",
							path: ["apiKey"],
						},
					),
			)
			.output(
				z.object({
					success: z.literal(true),
					message: z.string(),
				}),
			),

		/**
		 * Adaptive Connect — get an OAuth authorization URL for a connection
		 * POST /connections/adaptive-connect
		 *
		 * Used when a tool needs an OAuth token that doesn't exist yet or when
		 * additional consent is needed. Returns a URL to redirect the user through
		 * the provider's OAuth flow. Scopes default to connection config but can be
		 * explicitly constrained for least-privilege consent.
		 * Auth: user JWT only (raw token forwarded to Descope as MCP access token).
		 */
		adaptiveConnect: oc
			.route({
				method: "POST",
				path: "/adaptive-connect",
				summary: "Get OAuth connection URL (Adaptive Connect)",
				description:
					"Request an OAuth authorization URL for a connection. Redirect the user to the returned URL to grant access. Scopes are defined in the connection configuration.",
			})
			.input(
				z.object({
					/** Descope outbound app ID */
					appId: z.string().min(1),
					/** Where to redirect after the user grants OAuth consent */
					redirectUrl: z.url(),
					/** Optional Descope tenant ID to associate the token with */
					tenantId: z.string().optional(),
					/** Optional explicit scopes for this consent request */
					scopes: z.array(z.string()).optional(),
				}),
			)
			.output(
				z.object({
					/** OAuth authorization URL — redirect the user here */
					url: z.url(),
				}),
			),

		/**
		 * Disconnect a tedi from a connection provider
		 * DELETE /connections/tedi/{tediId}/{appId}
		 */
		disconnectTediProvider: oc
			.route({
				method: "DELETE",
				path: "/tedi/{tediId}/{appId}",
				summary: "Disconnect tedi from provider",
				description:
					"Remove a tedi's connection to a provider and delete stored tokens or API keys",
				successStatus: 200,
			})
			.input(
				z.object({
					...StatelessDestructiveConfirmationShape,
					reason: destructiveAuditReason(
						"Audit reason for the confirmed tedi provider disconnect",
					),
					tediId: z.uuid(),
					appId: z.string().min(1),
				}),
			)
			.output(
				z.object({
					success: z.literal(true),
					message: z.string(),
				}),
			),
	});

export type ConnectionsContract = typeof connectionsContract;

export {
	type AuditConnectionProviderSettingsInput,
	AuditConnectionProviderSettingsInputSchema,
	type AuditConnectionProviderSettingsOutput,
	AuditConnectionProviderSettingsOutputSchema,
	type ConnectionCredentialField,
	ConnectionCredentialFieldSchema,
	type ConnectionCredentialProfile,
	ConnectionCredentialProfileSchema,
	type ConnectionProvider,
	type ConnectionProviderConfig,
	ConnectionProviderConfigSchema,
	ConnectionProviderSchema,
	type CreateProviderFromMcpInput,
	CreateProviderFromMcpInputSchema,
	type CreateProviderFromMcpOutput,
	CreateProviderFromMcpOutputSchema,
	type UserConnection,
	UserConnectionSchema,
} from "../schemas/connections";
