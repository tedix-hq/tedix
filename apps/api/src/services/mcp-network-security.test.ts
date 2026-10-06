import { describe, expect, it, vi } from "vite-plus/test";
import type { McpNetworkControlConfig } from "@tedix/api-contract/schemas/mcp-network-security";
import {
	applyMcpPortalOnlyRule,
	buildMcpPortalOnlyRulePlan,
	reconcileMcpGatewayDetections,
} from "./mcp-network-security";

const observeConfig: McpNetworkControlConfig = {
	provider: "cloudflare_one",
	mode: "observe_only",
	cloudflareAccountId: "account-1",
	cloudflareConnectionId: "cloudflare",
	portalHostnames: ["portal.example.com"],
	directAccessExceptions: [
		{
			hostname: "legacy.example.com",
			reason: "Provider does not support a proxy client",
			expiresAt: "2026-09-01T00:00:00.000Z",
		},
	],
};

const detections = [
	{
		requestId: "portal",
		observedAt: "2026-08-20T12:00:00.000Z",
		destinationUrl: "https://portal.example.com/mcp",
		trafficSource: "mcp_portal" as const,
	},
	{
		requestId: "direct-approved",
		observedAt: "2026-08-20T12:01:00.000Z",
		destinationUrl: "https://github.example.com/mcp/tools/call",
		trafficSource: "device_client" as const,
	},
	{
		requestId: "unknown",
		observedAt: "2026-08-20T12:02:00.000Z",
		destinationUrl: "https://shadow.example.net/mcp",
		trafficSource: "device_client" as const,
	},
	{
		requestId: "exception",
		observedAt: "2026-08-20T12:03:00.000Z",
		destinationUrl: "https://legacy.example.com/mcp",
		trafficSource: "device_client" as const,
	},
];

describe("Cloudflare One MCP reconciliation", () => {
	it("separates unknown servers, approved direct use, portal traffic, and exceptions", () => {
		const result = reconcileMcpGatewayDetections({
			organizationId: "org-1",
			config: observeConfig,
			detections,
			approvedDestinations: [
				{ appSlug: "github", url: "https://github.example.com/mcp" },
			],
			now: new Date("2026-08-20T13:00:00.000Z"),
		});

		expect(result.counts).toEqual({
			approvedPortalRoute: 1,
			approvedServerDirect: 1,
			approvedServerPortalBypass: 0,
			approvedException: 1,
			unknownServer: 1,
		});
		expect(result.findings.map((finding) => finding.disposition)).toEqual([
			"allow",
			"observe",
			"observe",
			"allow",
		]);
	});

	it("turns approved direct use into portal bypass only in portal-only mode", () => {
		const result = reconcileMcpGatewayDetections({
			organizationId: "org-1",
			config: { ...observeConfig, mode: "portal_only" },
			detections: [detections[1]!],
			approvedDestinations: [
				{ appSlug: "github", url: "https://github.example.com/mcp" },
			],
		});
		expect(result.findings[0]).toMatchObject({
			classification: "approved_server_portal_bypass",
			disposition: "block",
		});
	});

	it("builds the documented Is MCP plus non-Portal Gateway expression", () => {
		const plan = buildMcpPortalOnlyRulePlan(
			"org-1",
			{
				...observeConfig,
				mode: "portal_only",
			},
			new Date("2026-08-20T13:00:00.000Z"),
		);
		expect(plan).toMatchObject({
			action: "block",
			filters: ["http"],
			enabled: true,
		});
		expect(plan.traffic).toContain("experimental.is_mcp == true");
		expect(plan.traffic).toContain('net.onramp.type != "mcp_portal"');
		expect(plan.traffic).toContain('"legacy.example.com"');
	});

	it("upserts one named rule without exposing the credential", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ success: true, result: [] })),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						success: true,
						result: { id: "rule-1", name: "Tedix MCP portal-only - org-1" },
					}),
				),
			);
		const result = await applyMcpPortalOnlyRule({
			accountId: "account-1",
			token: "secret-token",
			plan: buildMcpPortalOnlyRulePlan("org-1", {
				...observeConfig,
				mode: "portal_only",
			}),
			fetchImpl: fetchImpl as never,
		});

		expect(result).toEqual({ created: true, ruleId: "rule-1" });
		expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
		expect(String(fetchImpl.mock.calls[1]?.[1]?.body)).not.toContain(
			"secret-token",
		);
	});
});
