/**
 * MCP Credentials Schemas
 * For resolving auth headers that tedis need to connect to MCP servers
 */

import * as z from "zod";

export const ListServersInputSchema = z.object({
	/** The tedi requesting its assigned servers */
	tediId: z.string(),
});

export type ListServersInput = z.infer<typeof ListServersInputSchema>;

export const ListServersOutputSchema = z.object({
	servers: z.array(
		z.object({
			serverId: z.string(),
			url: z.string(),
			name: z.string(),
			transport: z.enum(["streamable-http", "sse"]).default("streamable-http"),
			authRequired: z.boolean(),
		}),
	),
});

export type ListServersOutput = z.infer<typeof ListServersOutputSchema>;

export const ResolveCredentialsInputSchema = z.object({
	/** The tedi requesting credentials */
	tediId: z.uuid(),
	/** The MCP server URL the tedi wants to connect to */
	serverUrl: z.url(),
	/** Home-supervised child authority; verified against the persisted Home run. */
	delegatedTurn: z
		.object({
			runId: z.string().min(1).max(256),
			homeRunId: z.string().min(1).max(256),
			workItemId: z.string().min(1).max(256),
		})
		.optional()
		.describe(
			"Home-supervised child dispatch binding; omitted for ordinary tedis",
		),
});

export type ResolveCredentialsInput = z.infer<
	typeof ResolveCredentialsInputSchema
>;

export const ConnectionRequiredSchema = z.object({
	/** Descope outbound app ID for the required provider */
	providerId: z.string(),
	/** URL to redirect user to initiate the OAuth connection */
	connectUrl: z.url(),
	/** Human-readable provider name for display */
	providerName: z.string(),
});

export type ConnectionRequired = z.infer<typeof ConnectionRequiredSchema>;

export const CatalogRefusedSchema = z.object({
	/** Normalized endpoint that failed the catalog-allowlist gate */
	endpoint: z.string(),
	/** Machine-readable refusal reason (e.g. "not_in_catalog", "invalid_url") */
	reason: z.string(),
});

export type CatalogRefused = z.infer<typeof CatalogRefusedSchema>;

export const ResolveCredentialsOutputSchema = z.object({
	/** Auth headers to include in the MCP connection */
	headers: z.record(z.string(), z.string()),
	/** Whether this tedi is the operator for the target app */
	isOperator: z.boolean(),
	/** Resolved app slug (if URL matched an app) */
	appSlug: z.string().nullable(),
	/** Token expiry (unix seconds), null if non-expiring */
	expiresAt: z.number().nullable(),
	/** Present when a connection is needed but doesn't exist yet */
	connectionRequired: ConnectionRequiredSchema.optional(),
	/**
	 * Present when the target is an external MCP server with no app_catalog
	 * row — the catalog is the connection allowlist and the request refused
	 * fail-closed (ADR decisions/tedi-client-oauth-cimd.md).
	 */
	catalogRefused: CatalogRefusedSchema.optional(),
});

export type ResolveCredentialsOutput = z.infer<
	typeof ResolveCredentialsOutputSchema
>;
