/**
 * Descope AIH Zod Schemas
 * Validation schemas for Descope AIH MCP Server/Client management
 */

import * as z from "zod";
import { JsonValueSchema } from "./common";

export const McpServerScopeSchema = z
	.object({
		name: z.string(),
		description: z.string().optional(),
		optional: z.boolean().optional(),
		values: z.array(z.string()).optional(),
	})
	.passthrough();

export type McpServerScope = z.infer<typeof McpServerScopeSchema>;

/** Descope uses a categorized scope object (not a flat array) for both input and output. */
export const ApprovedScopesSchema = z
	.object({
		permissionsScopes: z.array(McpServerScopeSchema).optional(),
		attributesScopes: z.array(McpServerScopeSchema).optional(),
		connectionsScopes: z.array(McpServerScopeSchema).optional(),
	})
	.passthrough();

export type ApprovedScopes = z.infer<typeof ApprovedScopesSchema>;

export const McpServerDynamicRegistrationSchema = z
	.object({
		enabled: z.boolean().optional(),
		flowId: z.string().nullish(),
		disableApprovedScopesAsDefault: z.boolean().nullish(),
	})
	.passthrough();

export const CimdDomainPolicySchema = z
	.object({
		domainPattern: z.string(),
		enabled: z.boolean().optional(),
	})
	.passthrough();

export const CimdSettingsSchema = z
	.object({
		enabled: z.boolean().optional(),
		domainPolicies: z
			.object({
				policies: z.array(CimdDomainPolicySchema).optional(),
			})
			.passthrough()
			.optional(),
	})
	.passthrough();

export const McpServerSessionSettingsSchema = z
	.object({
		enabled: z.boolean().optional(),
		refreshTokenExpiration: z.number().optional(),
		sessionTokenExpiration: z.number().optional(),
		keySessionTokenExpiration: z.number().optional(),
	})
	.passthrough();

export const McpServerRecordSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		description: z.string().nullish(),
		audienceWhitelist: z.array(z.string()).nullish(),
		approvedScopes: ApprovedScopesSchema.nullish(),
		approvedCallbackUrls: z.array(z.string()).nullish(),
		dynamicRegistration: McpServerDynamicRegistrationSchema.nullish(),
		loginPageURL: z.string().nullish(),
		loginPageUrl: z.string().nullish(),
		sessionSettings: McpServerSessionSettingsSchema.nullish(),
		tags: z.array(z.string()).nullish(),
		logo: z.string().nullish(),
		cimdSettings: CimdSettingsSchema.nullish(),
		skipConsentScreen: z.boolean().nullish(),
		forceAddAllAuthorizationInfo: z.boolean().nullish(),
	})
	.passthrough();

export type McpServerRecord = z.infer<typeof McpServerRecordSchema>;

export const DescopeAihDriftIssueSchema = z.object({
	severity: z.enum(["critical", "warning", "info"]),
	code: z.string(),
	message: z.string(),
	resourceType: z.enum([
		"mcp_server",
		"mcp_client",
		"outbound_app",
		"tenant",
		"role",
		"d1_app",
		"d1_tedi",
		"connection_provider",
		"fga_relation",
	]),
	resourceId: z.string().nullish(),
	resourceName: z.string().nullish(),
	details: z.record(z.string(), JsonValueSchema).optional(),
});

export type DescopeAihDriftIssue = z.infer<typeof DescopeAihDriftIssueSchema>;

export const DescopeAihMcpServerReconcileActionSchema = z.object({
	appId: z.uuid(),
	appSlug: z.string(),
	mcpServerId: z.string(),
	serverName: z.string().nullish(),
	action: z.enum(["skipped", "missing", "would_update", "updated"]),
	before: z.object({
		audienceWhitelist: z.array(z.string()),
		tags: z.array(z.string()),
		approvedScopes: z.array(z.string()),
		defaultGrantedScopes: z.array(z.string()),
	}),
	after: z.object({
		audienceWhitelist: z.array(z.string()),
		tags: z.array(z.string()),
		approvedScopes: z.array(z.string()),
		defaultGrantedScopes: z.array(z.string()),
	}),
});

export type DescopeAihMcpServerReconcileAction = z.infer<
	typeof DescopeAihMcpServerReconcileActionSchema
>;

export const DescopeAihClientAuditSchema = z.object({
	id: z.string(),
	name: z.string().nullish(),
	clientId: z.string().nullish(),
	mcpServerId: z.string().nullish(),
	status: z.string().nullish(),
	scopes: z.array(z.string()),
	tags: z.array(z.string()),
});

export type DescopeAihClientAudit = z.infer<typeof DescopeAihClientAuditSchema>;

export const DescopeAihClientRepairActionSchema = z.object({
	id: z.string(),
	name: z.string().nullish(),
	clientId: z.string().nullish(),
	status: z.string().nullish(),
	action: z.enum([
		"skipped",
		"would_update",
		"updated",
		"would_delete",
		"deleted",
	]),
	reason: z.string(),
	before: z.object({
		scopes: z.array(z.string()),
		tags: z.array(z.string()),
	}),
	after: z.object({
		scopes: z.array(z.string()),
		tags: z.array(z.string()),
	}),
});

export type DescopeAihClientRepairAction = z.infer<
	typeof DescopeAihClientRepairActionSchema
>;

export const DescopeAihServerAuditSchema = z.object({
	id: z.string(),
	name: z.string(),
	audienceWhitelist: z.array(z.string()),
	loginPageURL: z.string().nullish(),
	dynamicRegistrationFlowId: z.string().nullish(),
	disableApprovedScopesAsDefault: z.boolean(),
	cimdEnabled: z.boolean(),
	cimdDomainPolicies: z.array(z.string()),
	sessionSettingsEnabled: z.boolean(),
	tags: z.array(z.string()),
	hasLogo: z.boolean(),
	approvedScopes: z.array(z.string()),
	clientCount: z.number(),
	verifiedClientCount: z.number(),
	unverifiedClientCount: z.number(),
	untaggedClientCount: z.number(),
	broadClientCount: z.number(),
	codexClientCount: z.number(),
	taggedTediClientCount: z.number(),
});

export type DescopeAihServerAudit = z.infer<typeof DescopeAihServerAuditSchema>;

export const DescopeAihD1AppReferenceSchema = z.object({
	id: z.string(),
	slug: z.string(),
	name: z.string(),
	descopeResourceId: z.string(),
	authMode: z.string().nullish(),
	codeMode: z.boolean().nullish(),
	connectionProviderId: z.string().nullish(),
});

export const DescopeAihD1TediReferenceSchema = z.object({
	id: z.string(),
	slug: z.string(),
	name: z.string(),
	descopeMcpResourceId: z.string(),
	descopeUserId: z.string().nullish(),
});

export const DescopeOutboundProviderAuditSchema = z.object({
	id: z.string(),
	name: z.string().nullish(),
	appType: z.string().nullish(),
	hasClientId: z.boolean(),
	hasClientSecret: z.boolean(),
	hasLogo: z.boolean(),
	useDcr: z.boolean().nullish(),
	dcrUrl: z.string().nullish(),
	authorizationUrl: z.string().nullish(),
	tokenUrl: z.string().nullish(),
	defaultScopes: z.array(z.string()),
});

export const DescopeD1ConnectionProviderReferenceSchema = z.object({
	providerId: z.string(),
	appSlugs: z.array(z.string()),
	backing: z.enum(["descope", "missing"]),
	expectedType: z.enum(["oauth", "api_key"]).nullish(),
	actualType: z.string().nullish(),
	expectedUseDcr: z.boolean().nullish(),
	actualUseDcr: z.boolean().nullish(),
	expectedLogo: z.string().nullish(),
	hasLogo: z.boolean().nullish(),
});

export const DescopeAihDriftReportSchema = z.object({
	checkedAt: z.string(),
	projectId: z.string(),
	summary: z.object({
		mcpServers: z.number(),
		mcpClients: z.number(),
		outboundApps: z.number(),
		tenants: z.number(),
		roles: z.number(),
		d1AppsWithDescopeResource: z.number(),
		d1TedisWithDescopeResource: z.number(),
		issues: z.object({
			critical: z.number(),
			warning: z.number(),
			info: z.number(),
		}),
	}),
	issues: z.array(DescopeAihDriftIssueSchema),
	mcpServers: z.array(DescopeAihServerAuditSchema),
	d1Apps: z.array(DescopeAihD1AppReferenceSchema),
	d1Tedis: z.array(DescopeAihD1TediReferenceSchema),
	outboundApps: z.array(DescopeOutboundProviderAuditSchema),
	connectionProviders: z.array(DescopeD1ConnectionProviderReferenceSchema),
});

export type DescopeAihDriftReport = z.infer<typeof DescopeAihDriftReportSchema>;
