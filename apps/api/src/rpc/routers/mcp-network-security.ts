import { implement } from "@orpc/server";
import { mcpNetworkSecurityContract } from "@tedix/api-contract/contracts/mcp-network-security";
import { McpNetworkControlConfigSchema } from "@tedix/api-contract/schemas/mcp-network-security";
import { getManagementClient } from "@tedix/auth/client";
import { fetchTenantConnectionToken } from "@tedix/auth/connections";
import { insertAuditEvent } from "@tedix/db/queries/audit";
import { getAppsByOrganization } from "@tedix/db/queries/apps";
import { getConnectionProviderById } from "@tedix/db/queries/connection-providers";
import {
	getOrganizationById,
	updateOrganizationMetadata,
} from "@tedix/db/queries/organizations";
import { getToolsByAppId } from "@tedix/db/queries/tools";
import {
	applyMcpPortalOnlyRule,
	buildMcpPortalOnlyRulePlan,
	reconcileMcpGatewayDetections,
	type ApprovedMcpDestination,
} from "../../services/mcp-network-security";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
} from "../orpc";

const os = implement(mcpNetworkSecurityContract).$context<BaseContext>();
const authed = os.use(withAuth);

function requireOrganizationAdmin(
	context: BaseContext,
	organizationId: string,
): void {
	if (context.organizationId !== organizationId) {
		throw createError(ErrorCodes.FORBIDDEN, "Organization access denied");
	}
	if (!context.userRole || !["admin", "owner"].includes(context.userRole)) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Only organization admins and owners can manage MCP network security",
		);
	}
}

async function loadBoundary(context: BaseContext, organizationId: string) {
	requireOrganizationAdmin(context, organizationId);
	const organization = await getOrganizationById(context.db, organizationId);
	if (!organization) {
		throw createError(ErrorCodes.NOT_FOUND, "Organization not found");
	}
	const parsed = McpNetworkControlConfigSchema.safeParse(
		organization.metadata?.mcpNetworkControl,
	);
	if (!parsed.success) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Cloudflare One MCP network control is not configured for this organization",
		);
	}
	return { organization, config: parsed.data };
}

function addUrl(
	destinations: ApprovedMcpDestination[],
	appSlug: string,
	value: unknown,
): void {
	if (typeof value !== "string") return;
	try {
		const url = new URL(value.includes("://") ? value : `https://${value}`);
		if (url.protocol !== "https:" && url.protocol !== "http:") return;
		destinations.push({ appSlug, url: url.toString() });
	} catch {
		// Invalid stale config is omitted from the approved set, never approved.
	}
}

async function listApprovedDestinations(
	context: BaseContext,
	organizationId: string,
): Promise<ApprovedMcpDestination[]> {
	const apps = await getAppsByOrganization(context.db, organizationId);
	const destinations: ApprovedMcpDestination[] = [];
	await Promise.all(
		apps.map(async (app) => {
			addUrl(destinations, app.slug, `https://${app.slug}.mcp.tedix.dev/mcp`);
			addUrl(destinations, app.slug, app.customMcpDomain);
			const metadata =
				typeof app.metadata === "object" && app.metadata !== null
					? (app.metadata as Record<string, unknown>)
					: {};
			const mcpConfig =
				typeof metadata.mcpConfig === "object" && metadata.mcpConfig !== null
					? (metadata.mcpConfig as Record<string, unknown>)
					: {};
			addUrl(destinations, app.slug, mcpConfig.upstreamMcpUrl);
			for (const tool of await getToolsByAppId(context.db, app.id)) {
				const config = tool.config as Record<string, unknown> | null;
				addUrl(destinations, app.slug, config?.mcpServerUrl);
				addUrl(destinations, app.slug, config?.baseUrl);
				if (
					typeof config?.endpoint === "string" &&
					config.endpoint.includes("://")
				) {
					addUrl(destinations, app.slug, config.endpoint);
				}
			}
		}),
	);
	return destinations;
}

export const mcpNetworkSecurityContractRouter = os.router({
	getConfig: authed.getConfig
		.use(AUTHZ.settingsRead)
		.handler(async ({ input, context }) => {
			requireOrganizationAdmin(context, input.organizationId);
			const organization = await getOrganizationById(
				context.db,
				input.organizationId,
			);
			if (!organization) {
				throw createError(ErrorCodes.NOT_FOUND, "Organization not found");
			}
			const parsed = McpNetworkControlConfigSchema.safeParse(
				organization.metadata?.mcpNetworkControl,
			);
			return { config: parsed.success ? parsed.data : null };
		}),
	configure: authed.configure
		.use(AUTHZ.settingsWrite)
		.handler(async ({ input, context }) => {
			requireOrganizationAdmin(context, input.organizationId);
			const organization = await getOrganizationById(
				context.db,
				input.organizationId,
			);
			if (!organization) {
				throw createError(ErrorCodes.NOT_FOUND, "Organization not found");
			}
			const previous = McpNetworkControlConfigSchema.safeParse(
				organization.metadata?.mcpNetworkControl,
			);
			if (input.config.mode === "portal_only" && !previous.success) {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Configure and review observe_only mode before selecting portal_only",
				);
			}
			await updateOrganizationMetadata(context.db, input.organizationId, {
				mcpNetworkControl: input.config,
			});
			await insertAuditEvent(context.db, {
				organizationId: input.organizationId,
				actorId: context.user?.sub ?? "user",
				actorType: "user",
				action: "mcp.network.control.configured",
				resourceType: "organization_mcp_network_control",
				resourceId: input.organizationId,
				metadata: {
					provider: input.config.provider,
					previousMode: previous.success ? previous.data.mode : null,
					mode: input.config.mode,
					portalHostnameCount: input.config.portalHostnames.length,
					directExceptionCount: input.config.directAccessExceptions.length,
				},
			});
			return { config: input.config };
		}),
	reconcile: authed.reconcile
		.use(AUTHZ.analyticsRead)
		.handler(async ({ input, context }) => {
			const { config } = await loadBoundary(context, input.organizationId);
			const result = reconcileMcpGatewayDetections({
				organizationId: input.organizationId,
				config,
				detections: input.detections,
				approvedDestinations: await listApprovedDestinations(
					context,
					input.organizationId,
				),
			});
			await insertAuditEvent(context.db, {
				organizationId: input.organizationId,
				actorId: context.user?.sub ?? "user",
				actorType: "user",
				action: "mcp.network.detections.reconciled",
				resourceType: "mcp_network_detection_batch",
				metadata: {
					mode: result.mode,
					detectionCount: input.detections.length,
					approvedDestinationCount: result.approvedDestinationCount,
					...result.counts,
				},
			});
			return result;
		}),
	applyPortalOnlyPolicy: authed.applyPortalOnlyPolicy
		.use(AUTHZ.settingsWrite)
		.handler(async ({ input, context }) => {
			const { organization, config } = await loadBoundary(
				context,
				input.organizationId,
			);
			const plan = buildMcpPortalOnlyRulePlan(input.organizationId, config);
			if (input.dryRun) {
				return { applied: false, created: false, ruleId: null, plan };
			}
			if (config.mode !== "portal_only") {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Set mode=portal_only after reviewing observe-only findings before applying enforcement",
				);
			}
			if (input.confirmation !== "apply_portal_only") {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"confirmation=apply_portal_only is required for the external Cloudflare mutation",
				);
			}
			if (
				!context.env.DESCOPE_MANAGEMENT_KEY ||
				!organization.descopeTenantId
			) {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"Tenant-scoped Cloudflare Token Vault credentials are unavailable",
				);
			}
			const provider = await getConnectionProviderById(
				context.db,
				config.cloudflareConnectionId,
			);
			const descopeAppId =
				provider?.descopeAppId ?? config.cloudflareConnectionId;
			const client = getManagementClient({
				DESCOPE_PROJECT_ID: context.env.DESCOPE_PROJECT_ID,
				DESCOPE_MANAGEMENT_KEY: context.env.DESCOPE_MANAGEMENT_KEY,
				DESCOPE_BASE_URL: context.env.DESCOPE_BASE_URL,
			});
			const credential = await fetchTenantConnectionToken(
				client,
				descopeAppId,
				organization.descopeTenantId,
			);
			if (!credential?.accessToken) {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					"No tenant-scoped Cloudflare credential is connected",
				);
			}
			const applied = await applyMcpPortalOnlyRule({
				accountId: config.cloudflareAccountId,
				token: credential.accessToken,
				plan,
			});
			await insertAuditEvent(context.db, {
				organizationId: input.organizationId,
				actorId: context.user?.sub ?? "user",
				actorType: "user",
				action: "mcp.network.portal_only.applied",
				resourceType: "cloudflare_gateway_rule",
				resourceId: applied.ruleId,
				metadata: {
					provider: "cloudflare_one",
					mode: config.mode,
					created: applied.created,
					portalHostnameCount: config.portalHostnames.length,
					directExceptionCount: config.directAccessExceptions.length,
				},
			});
			return {
				applied: true,
				created: applied.created,
				ruleId: applied.ruleId,
				plan,
			};
		}),
});

export type McpNetworkSecurityContractRouter =
	typeof mcpNetworkSecurityContractRouter;
