import * as z from "zod";

const SelectedTenantIdsSchema = z
	.array(z.string().min(1).max(256))
	.min(1)
	.max(10)
	.refine((ids) => new Set(ids).size === ids.length);

const SelectedScopesSchema = z
	.array(z.string().min(1).max(200))
	.min(1)
	.max(100)
	.refine((scopes) => new Set(scopes).size === scopes.length);

/** Browser decision for one configured MCP resource. clientId may be a Descope app ID until verified. */
export const StageHumanMcpConsentInputSchema = z.strictObject({
	resourceUrl: z.url().max(2048),
	clientId: z.string().min(1).max(2048),
	selectedTenantIds: SelectedTenantIdsSchema,
	approvedScopes: SelectedScopesSchema,
});

export type StageHumanMcpConsentInput = z.infer<
	typeof StageHumanMcpConsentInputSchema
>;

export const RevokeHumanMcpConsentInputSchema = z.strictObject({
	resourceUrl: z.url().max(2048),
	clientId: z.string().min(1).max(2048),
});

export const HumanMcpConsentRevisionSchema = z.strictObject({
	revision: z.uuid(),
});

/** A request from the trusted MCP edge to recheck a human OAuth grant. */
export const VerifyHumanMcpGrantInputSchema = z.strictObject({
	descopeUserId: z.string().min(1).max(256),
	selectedTenantIds: SelectedTenantIdsSchema,
	mcpServerId: z.string().min(1).max(256),
	clientId: z.string().min(1).max(2048),
	consentId: z.string().min(1).max(256),
	consentRevision: z.uuid(),
	tokenScopes: SelectedScopesSchema,
});

export type VerifyHumanMcpGrantInput = z.infer<
	typeof VerifyHumanMcpGrantInputSchema
>;

/**
 * A client ID metadata document URL: https, a path, no credentials, query or
 * fragment. Anything else is an opaque (dynamically registered) client ID.
 */
export function isClientIdMetadataDocumentUrl(clientId: string): boolean {
	if (!URL.canParse(clientId)) return false;
	const url = new URL(clientId);
	return (
		url.protocol === "https:" &&
		url.pathname !== "/" &&
		!url.username &&
		!url.password &&
		!url.search &&
		!url.hash &&
		!clientId.includes("#") &&
		url.href === clientId
	);
}

/**
 * Organization admission policy for inbound human OAuth clients. In audit mode
 * every client is admitted and each consent and grant check records whether
 * the allowlist would have admitted it; in enforce mode only listed clients
 * are. Entries match the exact MCP server and the exact canonical client ID.
 * A dynamically registered (opaque) client ID is only an expiring exception.
 */
export const McpInboundClientPolicySchema = z.strictObject({
	mode: z.enum(["audit", "enforce"]),
	entries: z
		.array(
			z
				.strictObject({
					mcpServerId: z.string().min(1).max(256),
					clientId: z.string().min(1).max(2048),
					expiresAt: z.iso.datetime().optional(),
					note: z.string().max(500).optional(),
				})
				.refine(
					(entry) =>
						entry.expiresAt !== undefined ||
						isClientIdMetadataDocumentUrl(entry.clientId),
					"A client ID that is not a metadata document URL needs an expiry",
				),
		)
		.max(200),
});
export type McpInboundClientPolicy = z.infer<
	typeof McpInboundClientPolicySchema
>;

export const VerifyHumanMcpGrantResultSchema = z.strictObject({
	allowed: z.boolean(),
	reason: z.enum([
		"active",
		"consent_missing",
		"selection_replaced",
		"scope_missing",
		"membership_missing",
		"client_not_allowed",
		"provider_unavailable",
	]),
	organizations: z.array(
		z.strictObject({
			organizationId: z.uuid(),
			descopeTenantId: z.string(),
			gatewaySlug: z.string(),
		}),
	),
});

export const ListMcpAuthorizationsInputSchema = z.strictObject({
	limit: z.number().int().min(1).max(50).default(20),
	offset: z.number().int().min(0).max(10000).default(0),
});
export const McpAuthorizationSchema = z.strictObject({
	mcpServerId: z.string(),
	clientId: z.string(),
	clientName: z.string().nullable(),
	revision: z.uuid(),
	status: z.enum(["active", "revoked"]),
	providerStatus: z.enum(["present", "missing", "unavailable", "not_checked"]),
	selectedTenantIds: z.array(z.string()),
	approvedScopes: z.array(z.string()),
	updatedAt: z.string(),
});
export const ListMcpAuthorizationsResultSchema = z.strictObject({
	items: z.array(McpAuthorizationSchema),
	hasMore: z.boolean(),
});
export const DisableMcpAuthorizationInputSchema = z.strictObject({
	mcpServerId: z.string().min(1).max(256),
	clientId: z.string().min(1).max(2048),
	expectedRevision: z.uuid(),
});
export type McpAuthorization = z.infer<typeof McpAuthorizationSchema>;
