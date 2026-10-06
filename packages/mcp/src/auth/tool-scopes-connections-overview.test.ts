import { describe, expect, it } from "vite-plus/test";
import { toolToGranularCapabilityScope } from "@tedix/api-contract/schemas/mcp-capability-scopes";
import {
	isMcpToolVisibleToCaller,
	resolveMcpToolRequiredScopes,
} from "./tool-scopes";

describe("tenant connection overview authorization", () => {
	const namespace = "example_studio_unified";
	const overview = {
		toolId: `${namespace}__get_connections_overview`,
		toolTypeId: "rpc",
		config: {
			endpoint: "connections/getConnectionsOverview",
			_aggregateNamespace: namespace,
		},
		authRequired: true,
		writeCapability: "read" as const,
		annotations: { readOnlyHint: true, destructiveHint: false },
	};

	it("classifies the direct and organization aggregate overview as apps read", () => {
		for (const prefix of ["", "connections__", `${namespace}__`]) {
			expect(
				toolToGranularCapabilityScope(`${prefix}get_connections_overview`),
			).toBe("mcp:apps.read");
		}
		expect(resolveMcpToolRequiredScopes(overview, namespace, {})).toEqual([
			"mcp:apps.read",
		]);
	});

	it.each([
		{ scopes: ["mcp:apps.read"] },
		{ scopes: ["mcp:apps.read", "mcp:apps.write"] },
		{ scopes: ["mcp:apps.read", "mcp:apps.write", "mcp:apps.admin"] },
	])(
		"allows authenticated reader, author and admin profiles: $scopes",
		({ scopes }) => {
			expect(
				isMcpToolVisibleToCaller(
					overview,
					namespace,
					{},
					{
						authType: "oauth",
						scopes,
					},
				),
			).toBe(true);
		},
	);

	it.each([
		{ scopes: [] },
		{ scopes: ["connections.read"] },
		{ scopes: ["connections.execute"] },
		{ scopes: ["mcp:apps.write"] },
		{ scopes: ["mcp:apps.admin"] },
		{ scopes: ["mcp:work.admin"] },
		{ scopes: ["platform:admin"] },
	])(
		"denies callers without the exact apps read grant: $scopes",
		({ scopes }) => {
			expect(
				isMcpToolVisibleToCaller(
					overview,
					namespace,
					{},
					{
						authType: "oauth",
						scopes,
					},
				),
			).toBe(false);
		},
	);

	it("does not grant unauthenticated callers access", () => {
		expect(isMcpToolVisibleToCaller(overview, namespace, {}, {})).toBe(false);
	});

	it("keeps unclassified connection operations closed", () => {
		const unknown = {
			...overview,
			toolId: `${namespace}__get_connections_unreviewed`,
			config: { ...overview.config, endpoint: "connections/unreviewed" },
		};
		expect(() => resolveMcpToolRequiredScopes(unknown, namespace, {})).toThrow(
			/Missing MCP capability mapping/,
		);
		expect(
			isMcpToolVisibleToCaller(
				unknown,
				namespace,
				{},
				{
					authType: "oauth",
					scopes: ["mcp:apps.admin"],
				},
			),
		).toBe(false);
	});
});
