/**
 * Every endpoint tool-schema-sync projects as an MCP tool must resolve to a
 * capability scope when Connect serves it inside an organization mount.
 *
 * An unmapped endpoint ships green and then fails closed for every caller,
 * platform admins included, with "Missing MCP capability mapping". Map a new
 * endpoint in packages/mcp/src/auth/reviewed-rpc-endpoint-scopes.ts (from its
 * API guard, never looser than its dedicated namespace) or with an exact name
 * rule in packages/api-contract/src/schemas/mcp-capability-scopes.ts.
 */

import {
	resolveMcpToolNamespace,
	resolveMcpToolRequiredScopes,
} from "@tedix/mcp-shared/auth/tool-scopes";
import { describe, expect, it } from "vite-plus/test";
import { planToolSchemaSyncProjection } from "./tool-schema-sync";

const ADMIN_APP_ID = "00000000-0000-4000-8000-000000000001";

/**
 * Projected endpoints that resolve no scope under their generated tool name.
 * Most are served under reviewed names by apps/mcp platform-operator tools
 * (catalog/list as list_catalog_apps); the rest are not exposed live. This
 * list may only shrink: map an endpoint, then delete it here.
 */
const KNOWN_UNMAPPED = new Set([
	"apps/create",
	"apps/delete",
	"apps/provision",
	"apps/update",
	"billing/getOverview",
	"catalog/checkIntegrity",
	"catalog/createFromEndpoint",
	"catalog/getBySlug",
	"catalog/getCategories",
	"catalog/getHealthSummary",
	"catalog/getRecentChanges",
	"catalog/getStats",
	"catalog/getSyncLogs",
	"catalog/installFromCatalog",
	"catalog/list",
	"catalog/triggerScan",
	"catalog/triggerSync",
	"catalog/triggerToolTest",
	"connections/createProviderFromMcp",
	"connections/storeApiKey",
	"flywheelHealth/recordCronExecution",
	"sites/createCms",
	"tediEmail/recordOutcome",
	"tedis/get",
	"tedis/getStatus",
	"workflows/getStatus",
	"workflows/listRuns",
]);
const CONNECT_NAMESPACE = "acme_unified_tedix";

describe("tool-schema-sync scope coverage", () => {
	it("maps every projected endpoint to a capability scope", () => {
		const { endpoints, toolIds } = planToolSchemaSyncProjection(
			{},
			ADMIN_APP_ID,
		);
		expect(endpoints.length).toBeGreaterThan(500);

		const unmapped: string[] = [];
		for (const endpoint of endpoints) {
			const toolId = toolIds[endpoint];
			if (!toolId) continue;
			const tool = {
				toolId: `${CONNECT_NAMESPACE}__${toolId}`,
				toolTypeId: "rpc",
				authRequired: true,
				config: { endpoint, _aggregateNamespace: CONNECT_NAMESPACE },
			};
			try {
				resolveMcpToolRequiredScopes(
					tool,
					resolveMcpToolNamespace(tool),
					{ enforcePolicies: false, authMode: "authenticated" },
					{ fallbackOnAuthenticatedAuthMode: true },
				);
			} catch {
				unmapped.push(endpoint);
			}
		}
		expect(
			unmapped.filter((endpoint) => !KNOWN_UNMAPPED.has(endpoint)),
			"new endpoints without an MCP capability mapping",
		).toEqual([]);
		expect(
			[...KNOWN_UNMAPPED].filter((endpoint) => !unmapped.includes(endpoint)),
			"now-mapped endpoints to delete from KNOWN_UNMAPPED",
		).toEqual([]);
	});
});
