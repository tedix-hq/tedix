import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import { baseErrors } from "../errors";
import {
	ApplyMcpPortalOnlyPolicyInputSchema,
	ApplyMcpPortalOnlyPolicyOutputSchema,
	ConfigureMcpNetworkSecurityInputSchema,
	ConfigureMcpNetworkSecurityOutputSchema,
	GetMcpNetworkSecurityConfigInputSchema,
	GetMcpNetworkSecurityConfigOutputSchema,
	ReconcileMcpNetworkSecurityInputSchema,
	ReconcileMcpNetworkSecurityOutputSchema,
} from "../schemas/mcp-network-security";

export const mcpNetworkSecurityContract = oc
	.route({ tags: ["mcp-network-security"], prefix: "/mcpNetworkSecurity" })
	.errors(baseErrors)
	.router({
		getConfig: oc
			.route({
				method: "GET",
				path: "/config/{organizationId}",
				summary: "Read the tenant MCP network boundary",
			})
			.input(GetMcpNetworkSecurityConfigInputSchema)
			.output(GetMcpNetworkSecurityConfigOutputSchema),
		configure: oc
			.route({
				method: "POST",
				path: "/configure",
				summary: "Configure the tenant Cloudflare One MCP boundary",
				description:
					"Stores tenant-owned account, Portal, exception, and mode configuration in D1. First-time configuration must be observe_only; changing to portal_only is a separate audited step and still does not mutate Cloudflare.",
			})
			.input(ConfigureMcpNetworkSecurityInputSchema)
			.output(ConfigureMcpNetworkSecurityOutputSchema),
		reconcile: oc
			.route({
				method: "POST",
				path: "/reconcile",
				summary: "Reconcile Cloudflare Gateway MCP detections",
				description:
					"Classifies bounded Gateway MCP detections against the live Tedix app/tool catalog. This is observe-only analysis even when portal-only mode is configured; it does not mutate Cloudflare.",
			})
			.input(ReconcileMcpNetworkSecurityInputSchema)
			.output(ReconcileMcpNetworkSecurityOutputSchema),
		applyPortalOnlyPolicy: oc
			.route({
				method: "POST",
				path: "/apply-portal-only-policy",
				summary: "Dry-run or apply the Cloudflare Portal-only MCP rule",
				description:
					"Defaults to dry-run. A live call requires portal_only organization config plus confirmation=apply_portal_only, then upserts one scoped HTTP block rule using the tenant Cloudflare Token Vault credential.",
			})
			.input(ApplyMcpPortalOnlyPolicyInputSchema)
			.output(ApplyMcpPortalOnlyPolicyOutputSchema),
	});

export type McpNetworkSecurityContract = typeof mcpNetworkSecurityContract;
