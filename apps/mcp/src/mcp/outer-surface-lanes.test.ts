import { CatalogueSearchInputJsonSchema } from "@tedix/api-contract/schemas/tools";
/**
 * Outer-surface lane conformance: the
 * registered outer tool surface per lane is a decided contract, not an
 * accident of two code paths. docs/mcp/codemode.md documents the decision;
 * this test pins it so registration and documentation cannot drift.
 *
 * Lane decision:
 * - Stateless fast path (`compactCodeModeTools`): `code` + `get_info` + authenticated `get_profile` for every
 *   caller. Deliberately no `ask` — it creates a durable Home turn and needs an authenticated org
 *   context the stateless lane does not resolve.
 * - Session Code Mode lane: `code` plus the home-surface tools named by
 *   SESSION_NATIVE_HOME_TOOL_IDS (exactly `ask`), plus get_info and authenticated profile bootstrap.
 */

import { describe, expect, it } from "vite-plus/test";

import { compactCodeModeTools, mcpToolsListResultTransform } from "../index";
import { SESSION_NATIVE_HOME_TOOL_IDS } from "./server-factory";

function resolvedAppStub() {
	return {
		app: { slug: "tedix-unified", name: "Tedix" },
		metadata: { mcpConfig: { codeMode: true, authMode: "authenticated" } },
	} as never;
}

describe("outer-surface lanes", () => {
	it.each([
		["public", [{ type: "noauth" }]],
		["authenticated", [{ type: "oauth2", scopes: ["mcp:work.read"] }]],
		[
			"hybrid",
			[{ type: "noauth" }, { type: "oauth2", scopes: ["mcp:work.read"] }],
		],
	])(
		"compact code advertises %s app auth without widening inner scopes",
		(authMode, securitySchemes) => {
			const tools = compactCodeModeTools(
				{
					app: { slug: "connect", name: "Tedix" },
					metadata: {
						mcpConfig: {
							codeMode: true,
							authMode,
							toolScopes: {
								code: ["mcp:work.read"],
								create_os_output: ["mcp:apps.write"],
							},
						},
					},
				} as never,
				new Headers(),
			);
			expect(tools[0]?._meta).toEqual({ securitySchemes });
			expect(tools[0]?.securitySchemes).toEqual(securitySchemes);
			expect(tools[0]?.annotations).toEqual({
				readOnlyHint: false,
				destructiveHint: true,
				openWorldHint: true,
			});
			const transform = mcpToolsListResultTransform(
				[{ toolId: "sample_read", authRequired: false }],
				{ codeMode: true, authMode, toolScopes: { code: ["mcp:work.read"] } },
				new Headers({ "x-tedix-auth-type": "service" }),
			);
			const transformed = transform({
				request: { jsonrpc: "2.0", id: 1, method: "tools/list" },
				response: {
					jsonrpc: "2.0",
					id: 1,
					result: { tools: [{ name: "code", _meta: { securitySchemes } }] },
				},
			} as never);
			if (!("result" in transformed))
				throw new Error("Expected tools/list result");
			const listed = transformed.result.tools as Array<Record<string, unknown>>;
			expect(listed[0]?.securitySchemes).toEqual(securitySchemes);
			expect(listed[0]?._meta).toEqual({ securitySchemes });
		},
	);
	it("stateless fast path advertises code + get_info (no ask) independent of caller identity", () => {
		const tools = compactCodeModeTools(resolvedAppStub(), new Headers());
		expect(tools.map((tool) => tool.name)).toEqual([
			"code",
			"get_info",
			"get_profile",
		]);
	});

	it("session lane's native home surface is exactly ask", () => {
		expect([...SESSION_NATIVE_HOME_TOOL_IDS]).toEqual(["ask"]);
	});
	it("public apps do not advertise a personal account profile", () => {
		expect(
			compactCodeModeTools(
				{
					app: { name: "Public" },
					metadata: { mcpConfig: { codeMode: true, authMode: "public" } },
				} as never,
				new Headers(),
			).map((t) => t.name),
		).toEqual(["code", "get_info"]);
	});
	it("preserves the standard account profile wire declaration without capability scope union", () => {
		const transform = mcpToolsListResultTransform(
			[],
			{ codeMode: true },
			new Headers(),
		);
		const response = transform({
			request: { jsonrpc: "2.0", id: 1, method: "tools/list" },
			response: {
				jsonrpc: "2.0",
				id: 1,
				result: {
					tools: [{ name: "get_profile", _meta: { "openai/profile": true } }],
				},
			},
		} as never);
		if (!("result" in response)) throw new Error("Expected tools/list result");
		expect(response.result.tools).toEqual([
			{
				name: "get_profile",
				_meta: { "openai/profile": true },
				securitySchemes: [{ type: "oauth2", scopes: [] }],
			},
		]);
	});
});

describe("configured compact native catalog rows", () => {
	function app(
		rows: unknown[],
		scopes: Record<string, string[]> = { find_tools: ["mcp:catalog.read"] },
	) {
		return {
			app: { slug: "tedix-unified", name: "Tedix" },
			tools: rows,
			metadata: {
				mcpConfig: {
					codeMode: true,
					authMode: "authenticated",
					toolScopes: scopes,
				},
			},
		} as never;
	}
	const row = {
		id: "fictional",
		toolId: "find_tools",
		title: "Find permitted tools",
		description: "Stored description",
		toolTypeId: "rpc",
		enabled: true,
		config: { transport: "catalog", endpoint: "catalog/search" },
		inputSchema: CatalogueSearchInputJsonSchema,
		outputSchema: { type: "object" },
		annotations: { readOnlyHint: true },
	};
	const headers = new Headers({
		"x-tedix-auth-type": "oauth",
		"x-tedix-auth-scopes": "mcp:catalog.read",
	});
	it("uses actual configured metadata and caller capability, never aggregate hydration", () => {
		const tools = compactCodeModeTools(app([row]), headers);
		expect(tools.find((tool) => tool.name === "find_tools")).toMatchObject({
			title: row.title,
			description: row.description,
			inputSchema: row.inputSchema,
			outputSchema: row.outputSchema,
			annotations: row.annotations,
			securitySchemes: [{ type: "oauth2", scopes: ["mcp:catalog.read"] }],
		});
		expect(
			compactCodeModeTools(app([row]), new Headers()).some(
				(tool) => tool.name === "find_tools",
			),
		).toBe(false);
		expect(
			compactCodeModeTools(app([row], {}), headers).some(
				(tool) => tool.name === "find_tools",
			),
		).toBe(false);
		expect(
			compactCodeModeTools(app([row, row]), headers).some(
				(tool) => tool.name === "find_tools",
			),
		).toBe(false);
		expect(
			compactCodeModeTools(
				app([{ ...row, toolId: "code" }], { code: ["mcp:catalog.read"] }),
				headers,
			).filter((tool) => tool.name === "code"),
		).toHaveLength(1);
	});
});

it("native opt-in remains server configuration and does not borrow caller scopes in compact listing", () => {
	const tools = compactCodeModeTools(
		{
			app: { slug: "tedix-unified", name: "Tedix" },
			tools: [
				{
					id: "configured",
					toolId: "read_work",
					enabled: true,
					toolTypeId: "rpc",
					config: {
						transport: "rpc",
						endpoint: "workItems/list",
						nativeDirect: true,
					},
					inputSchema: { type: "object", properties: {} },
					title: "Read Work",
				},
			],
			metadata: {
				mcpConfig: {
					codeMode: true,
					toolScopes: { read_work: ["mcp:work.read"] },
				},
			},
		} as never,
		new Headers({
			"x-tedix-auth-type": "oauth",
			"x-tedix-auth-scopes": "mcp:catalog.read",
		}),
	);
	expect(tools.map((row) => row.name)).not.toContain("read_work");
});

it("aggregate native pages bind the complete authorized sorted registry and refuse stale cursors", async () => {
	const { aggregateNativeTools } = await import("./registration/bootstrap");
	const { paginateAggregateNativeTools: paginateSortedToolsList } =
		await import("./registration/bootstrap");
	const rows = Array.from({ length: 205 }, (_, i) => ({
		id: "row-" + i,
		toolId: "alpha__get_work_" + String(i).padStart(3, "0"),
		enabled: true,
		toolTypeId: "rpc",
		inputSchema: { type: "object", properties: {} },
		config: {
			transport: "rpc",
			endpoint: "workItems/getById",
			nativeDirect: true,
			_multiOrgOrganizationId: "alpha",
			_aggregateNamespace: "alpha",
			_sourceAppId: "alpha-gateway",
		},
	}));
	const ctx = {
		appSlug: "connect",
		appMetadata: {
			mcpConfig: {
				multiOrgConsent: true,
				authMode: "authenticated",
				toolScopes: Object.fromEntries(
					rows.map((row) => [row.toolId, ["mcp:work.read"]]),
				),
			},
		},
		callerIdentity: {
			authType: "oauth",
			scopes: ["mcp:work.read"],
			verifiedMultiOrgOrganizations: [
				{
					organizationId: "alpha",
					gatewaySlug: "alpha",
					descopeTenantId: "alpha",
				},
			],
		},
	} as unknown as import("./server-context").ServerContext;
	const view = aggregateNativeTools(
		ctx,
		rows as unknown as import("./server-context").AppTool[],
	).map((row) => ({ name: row.toolId }));
	expect(view).toHaveLength(205);
	const sorted = view.toSorted((a, b) => a.name.localeCompare(b.name));
	const first = paginateSortedToolsList(sorted, undefined);
	expect(first.ok).toBe(true);
	if (!first.ok || !first.nextCursor) throw new Error("Expected page");
	const second = paginateSortedToolsList(sorted, first.nextCursor);
	expect(second.ok).toBe(true);
	expect(
		paginateSortedToolsList(
			sorted.filter((_, index) => index !== 199),
			first.nextCursor,
		).ok,
	).toBe(false);
	expect(paginateSortedToolsList(sorted, "forged").ok).toBe(false);
	const revoked = aggregateNativeTools(
		{
			...ctx,
			callerIdentity: {
				...ctx.callerIdentity!,
				verifiedMultiOrgOrganizations: [],
			},
		},
		rows as unknown as import("./server-context").AppTool[],
	);
	expect(
		paginateSortedToolsList(
			revoked.map((row) => ({ name: row.toolId })),
			first.nextCursor,
		).ok,
	).toBe(false);
	const reversed = aggregateNativeTools(
		ctx,
		[...rows].reverse() as unknown as import("./server-context").AppTool[],
	)
		.map((row) => ({ name: row.toolId }))
		.toSorted((a, b) => a.name.localeCompare(b.name));
	expect(paginateSortedToolsList(reversed, undefined)).toEqual(first);
});
