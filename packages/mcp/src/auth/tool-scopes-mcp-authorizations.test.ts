import { describe, expect, it } from "vite-plus/test";
import {
	isMcpToolVisibleToCaller,
	resolveMcpToolRequiredScopes,
	type ToolAuthShape,
} from "./tool-scopes";

const inventory: ToolAuthShape = {
	toolId: "list_mcp_authorizations",
	toolTypeId: "rpc",
	config: { endpoint: "organizations/listMcpAuthorizations" },
	authRequired: true,
	visibility: "private",
	writeCapability: "read",
	annotations: { readOnlyHint: true },
};

describe("human MCP authorization inventory scope", () => {
	it.each([
		{ toolId: "list_mcp_authorizations", namespace: "organizations" },
		{
			toolId: "tedix_unified__list_mcp_authorizations",
			namespace: "tedix_unified",
		},
	])(
		"requires apps read for canonical RPC pair $toolId",
		({ toolId, namespace }) => {
			const tool = { ...inventory, toolId };
			expect(resolveMcpToolRequiredScopes(tool, namespace, {})).toEqual([
				"mcp:apps.read",
			]);
			expect(
				isMcpToolVisibleToCaller(
					tool,
					namespace,
					{},
					{ authType: "oauth", scopes: ["mcp:apps.read"] },
				),
			).toBe(true);
		},
	);
	it.each([
		{ scopes: [] },
		{ scopes: ["connections.read"] },
		{ scopes: ["mcp:apps.write"] },
		{ scopes: ["mcp:apps.admin"] },
	])("denies a caller lacking apps read: $scopes", ({ scopes }) => {
		expect(
			isMcpToolVisibleToCaller(
				inventory,
				"organizations",
				{},
				{ authType: "oauth", scopes },
			),
		).toBe(false);
	});
	it("denies unauthenticated inventory access", () => {
		expect(isMcpToolVisibleToCaller(inventory, "organizations", {}, {})).toBe(
			false,
		);
	});
	const mismatches: ToolAuthShape[] = [
		{ ...inventory, config: { endpoint: "organizations/get" } },
		{ ...inventory, config: {} },
		{ ...inventory, config: null },
		{ ...inventory, toolId: "list_mcp_authorizations_unreviewed" },
		{ ...inventory, toolId: "tedix_unified__list_apps" },
		{ ...inventory, toolTypeId: "mcp" },
		{ ...inventory, toolTypeId: null },
	];
	it.each(mismatches)(
		"rejects mismatched inventory metadata %# before overrides",
		(tool) => {
			for (const config of [
				{},
				{ toolScopes: { "*": ["mcp:apps.read"] } },
				{ enforcePolicies: true },
			]) {
				for (const candidate of [
					tool,
					{
						...tool,
						config: {
							...tool.config,
							auth: { type: "connection", connectionId: "firecrawl" },
							connectionReadOnly: true,
						},
					},
				]) {
					expect(() =>
						resolveMcpToolRequiredScopes(candidate, "organizations", config),
					).toThrow(/invalid authorization inventory RPC binding/);
					expect(
						isMcpToolVisibleToCaller(candidate, "organizations", config, {
							authType: "oauth",
							scopes: ["mcp:apps.read", "connections.read", "*"],
						}),
					).toBe(false);
				}
			}
		},
	);
	it("preserves destructive metadata elevation", () => {
		expect(
			resolveMcpToolRequiredScopes(
				{
					...inventory,
					annotations: { readOnlyHint: true, destructiveHint: true },
				},
				"organizations",
				{},
			),
		).toEqual(["mcp:apps.admin"]);
	});
	it("preserves unrelated RPC classification", () => {
		expect(
			resolveMcpToolRequiredScopes(
				{
					...inventory,
					toolId: "get_connections_overview",
					config: { endpoint: "connections/getConnectionsOverview" },
				},
				"connections",
				{},
			),
		).toEqual(["mcp:apps.read"]);
	});
});
