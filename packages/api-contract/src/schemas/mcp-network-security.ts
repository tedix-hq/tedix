import * as z from "zod";

const HostnameSchema = z
	.string()
	.min(1)
	.max(253)
	.regex(
		/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
		"Expected a lowercase DNS hostname",
	);

export const McpNetworkControlConfigSchema = z.object({
	provider: z.literal("cloudflare_one"),
	mode: z.enum(["observe_only", "portal_only"]),
	cloudflareAccountId: z.string().min(1).max(64),
	cloudflareConnectionId: z.string().min(1).max(160).default("cloudflare"),
	portalHostnames: z.array(HostnameSchema).min(1).max(50),
	directAccessExceptions: z
		.array(
			z.object({
				hostname: HostnameSchema,
				reason: z.string().min(1).max(240),
				expiresAt: z.iso
					.datetime()
					.optional()
					.describe(
						"Optional expiry; absence is an explicit non-expiring exception and should be reviewed periodically.",
					),
			}),
		)
		.max(100)
		.default([]),
});
export type McpNetworkControlConfig = z.infer<
	typeof McpNetworkControlConfigSchema
>;

export const McpGatewayDetectionSchema = z.object({
	requestId: z.string().min(1).max(200),
	observedAt: z.iso.datetime(),
	destinationUrl: z.url().max(2048),
	trafficSource: z.enum([
		"device_client",
		"mesh",
		"cloudflare_wan",
		"proxy_endpoint",
		"mcp_portal",
		"other",
	]),
	actorRef: z
		.string()
		.max(200)
		.optional()
		.describe(
			"Optional tenant-local opaque actor reference. Do not send access tokens, request bodies, tool arguments, or raw user email addresses.",
		),
});
export type McpGatewayDetection = z.infer<typeof McpGatewayDetectionSchema>;

export const McpNetworkFindingSchema = z.object({
	requestId: z.string(),
	observedAt: z.string(),
	destinationOrigin: z.string(),
	trafficSource: McpGatewayDetectionSchema.shape.trafficSource,
	classification: z.enum([
		"approved_portal_route",
		"approved_server_direct",
		"approved_server_portal_bypass",
		"approved_exception",
		"unknown_server",
	]),
	disposition: z.enum(["allow", "observe", "block"]),
	approvedAppSlugs: z.array(z.string()),
});

export const McpGatewayRulePlanSchema = z.object({
	name: z.string(),
	action: z.literal("block"),
	filters: z.tuple([z.literal("http")]),
	traffic: z.string(),
	enabled: z.boolean(),
});
export type McpGatewayRulePlan = z.infer<typeof McpGatewayRulePlanSchema>;

export const ReconcileMcpNetworkSecurityInputSchema = z.object({
	organizationId: z.uuid(),
	detections: z.array(McpGatewayDetectionSchema).max(1000),
});

export const ConfigureMcpNetworkSecurityInputSchema = z.object({
	organizationId: z.uuid(),
	config: McpNetworkControlConfigSchema,
});

export const ConfigureMcpNetworkSecurityOutputSchema = z.object({
	config: McpNetworkControlConfigSchema,
});

export const GetMcpNetworkSecurityConfigInputSchema = z.object({
	organizationId: z.uuid(),
});

export const GetMcpNetworkSecurityConfigOutputSchema = z.object({
	config: McpNetworkControlConfigSchema.nullable().describe(
		"Null until an organization admin configures the optional Cloudflare One overlay.",
	),
});

export const ReconcileMcpNetworkSecurityOutputSchema = z.object({
	mode: McpNetworkControlConfigSchema.shape.mode,
	approvedDestinationCount: z.number().int(),
	counts: z.object({
		approvedPortalRoute: z.number().int(),
		approvedServerDirect: z.number().int(),
		approvedServerPortalBypass: z.number().int(),
		approvedException: z.number().int(),
		unknownServer: z.number().int(),
	}),
	findings: z.array(McpNetworkFindingSchema),
	enforcementPlan: McpGatewayRulePlanSchema,
});

export const ApplyMcpPortalOnlyPolicyInputSchema = z.object({
	organizationId: z.uuid(),
	dryRun: z.boolean().default(true),
	confirmation: z
		.literal("apply_portal_only")
		.optional()
		.describe(
			"Required when dryRun is false. This is an external Cloudflare Gateway mutation.",
		),
});

export const ApplyMcpPortalOnlyPolicyOutputSchema = z.object({
	applied: z.boolean(),
	created: z.boolean(),
	ruleId: z
		.string()
		.nullable()
		.describe(
			"Null on dry-run because no Cloudflare Gateway rule was created or updated.",
		),
	plan: McpGatewayRulePlanSchema,
});
