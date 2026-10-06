import { describe, expect, it } from "vite-plus/test";
import {
	isMcpToolVisibleToCaller,
	resolveMcpToolRequiredScopes,
} from "./tool-scopes";

function connectedTool(
	writeCapability: "read" | "write" | "destructive" | null,
	overrides: Record<string, unknown> = {},
) {
	return {
		toolId: "vendor__operate_record",
		writeCapability,
		annotations: null,
		config: {
			auth: { type: "connection", connectionId: "vendor-oauth" },
			_aggregateConnectionProviderId: "vendor-oauth",
		},
		...overrides,
	};
}

describe("connected-app authorization plane", () => {
	it("requires the exact connection grant for reads", () => {
		expect(
			resolveMcpToolRequiredScopes(connectedTool("read"), "vendor", {
				toolScopes: { "*": ["mcp:content.write"] },
			}),
		).toEqual(["connections.execute"]);
	});

	it("uses the same bounded execution grant for non-destructive writes", () => {
		expect(
			resolveMcpToolRequiredScopes(connectedTool("write"), "vendor", {}),
		).toEqual(["connections.execute"]);
	});

	it("adds an explicit connection-admin grant for destructive actions", () => {
		expect(
			resolveMcpToolRequiredScopes(connectedTool("destructive"), "vendor", {}),
		).toEqual(["connections.execute", "connections.admin"]);
	});

	it("fails closed when aggregate provider metadata disagrees with auth", () => {
		const tool = connectedTool("read");
		tool.config._aggregateConnectionProviderId = "other-provider";
		expect(() => resolveMcpToolRequiredScopes(tool, "vendor", {})).toThrow(
			/Missing MCP capability mapping/,
		);
	});

	it("does not treat a spoofed marker without connection auth as a grant", () => {
		expect(() =>
			resolveMcpToolRequiredScopes(
				{
					toolId: "vendor__read_record",
					writeCapability: "read",
					config: { _aggregateConnectionProviderId: "vendor-oauth" },
				},
				"vendor",
				{},
			),
		).toThrow(/Missing MCP capability mapping/);
	});
});

describe("connected Notion page updates", () => {
	const notion = {
		toolId: "notion-tedix__notion-update-page",
		writeCapability: "destructive" as const,
		annotations: { destructiveHint: true },
		config: {
			auth: { type: "connection", connectionId: "notion" },
			_aggregateConnectionProviderId: "notion",
		},
	};
	const required = (args?: unknown) =>
		resolveMcpToolRequiredScopes(
			notion,
			"notion_tedix",
			{},
			args === undefined ? {} : { toolCall: { arguments: args } },
		);

	it("advertises an execute path while retaining the destructive annotation", () => {
		expect(notion.annotations.destructiveHint).toBe(true);
		expect(required()).toEqual(["connections.execute"]);
		expect(
			isMcpToolVisibleToCaller(
				notion,
				"notion_tedix",
				{},
				{
					authType: "tedi",
					scopes: ["connections.execute"],
				},
			),
		).toBe(true);
	});

	it.each([
		{
			page_id: "page",
			command: "update_properties",
			properties: { Name: "A" },
		},
		{ page_id: "page", command: "insert_content", content: "New note" },
		{
			page_id: "page",
			command: "update_content",
			content_updates: [{ old_str: "old", new_str: "new" }],
			allow_deleting_content: false,
		},
	])("permits a bounded safe command under execute: $command", (args) => {
		expect(required(args)).toEqual(["connections.execute"]);
	});

	it.each([
		undefined,
		null,
		{},
		{ page_id: "page", command: "replace_content", new_str: "replacement" },
		{ page_id: "page", command: "apply_template", template_id: "template" },
		{
			page_id: "page",
			command: "update_verification",
			verification_status: "verified",
		},
		{ page_id: "page", command: "unknown" },
		{
			page_id: "page",
			command: "update_content",
			content_updates: [{ old_str: "old", new_str: "new" }],
			allow_deleting_content: true,
		},
		{
			page_id: "page",
			command: "update_properties",
			properties: { Name: "A" },
			icon: "none",
		},
		{
			page_id: "page",
			command: "insert_content",
			content: "New note",
			is_skill: true,
		},
	])("retains admin for destructive or ambiguous arguments: %j", (args) => {
		expect(
			resolveMcpToolRequiredScopes(
				notion,
				"notion_tedix",
				{},
				{
					toolCall: { arguments: args },
				},
			),
		).toEqual(["connections.execute", "connections.admin"]);
	});

	it("does not extend the exception to another provider or forged metadata", () => {
		expect(
			resolveMcpToolRequiredScopes(
				{
					...notion,
					config: {
						...notion.config,
						auth: { type: "connection", connectionId: "another" },
						_aggregateConnectionProviderId: "another",
					},
				},
				"notion_tedix",
				{},
				{
					toolCall: {
						arguments: {
							page_id: "page",
							command: "insert_content",
							content: "x",
						},
					},
				},
			),
		).toEqual(["connections.execute", "connections.admin"]);
		expect(
			resolveMcpToolRequiredScopes(
				{ ...notion, annotations: null, writeCapability: "write" },
				"notion_tedix",
				{},
				{
					toolCall: {
						arguments: { page_id: "page", command: "replace_content" },
					},
				},
			),
		).toEqual(["connections.execute", "connections.admin"]);
	});
});

describe("reviewed connected reads", () => {
	const reviewed = () => ({
		...connectedTool("read"),
		config: { ...connectedTool("read").config, connectionReadOnly: true },
	});
	it("permits only reviewed reads under read authority and retains execute access", () => {
		const t = reviewed();
		expect(resolveMcpToolRequiredScopes(t, "vendor", {})).toEqual([
			"connections.read",
		]);
		for (const scopes of [["connections.read"], ["connections.execute"]]) {
			expect(
				isMcpToolVisibleToCaller(
					t,
					"vendor",
					{},
					{ authType: "oauth", scopes },
				),
			).toBe(true);
		}
	});
	it.each([
		connectedTool("read"),
		{ ...reviewed(), writeCapability: null },
		{ ...reviewed(), writeCapability: "write" as const },
		{ ...reviewed(), annotations: { readOnlyHint: false } },
		{ ...connectedTool(null), annotations: { readOnlyHint: true } },
	])(
		"does not let upstream hints or conflicting declarations establish read authority",
		(t) => {
			expect(resolveMcpToolRequiredScopes(t, "vendor", {})).toEqual([
				"connections.execute",
			]);
			expect(
				isMcpToolVisibleToCaller(
					t,
					"vendor",
					{},
					{ authType: "oauth", scopes: ["connections.read"] },
				),
			).toBe(false);
		},
	);
	it.each([
		{ ...reviewed(), writeCapability: "destructive" as const },
		{
			...reviewed(),
			annotations: { readOnlyHint: true, destructiveHint: true },
		},
		{ ...reviewed(), toolId: "vendor__delete_record" },
	])("destructive authority wins over a read review", (t) => {
		expect(resolveMcpToolRequiredScopes(t, "vendor", {})).toEqual([
			"connections.execute",
			"connections.admin",
		]);
	});
});
