import { NATIVE_CATALOG_TOOLS } from "./native-catalog-tools";
/**
 * Outer-surface lane conformance: the
 * registered outer tool surface per lane is a decided contract, not an
 * accident of two code paths. docs/engineering/mcp/codemode.md documents the decision;
 * this test pins it so registration and documentation cannot drift.
 *
 * Lane decision:
 * - Stateless fast path (`compactCodeModeTools`): `code` alone for every caller, plus configured
 *   catalog rows and exact `mcpConfig.codeModeNativeTools` opt-ins (e.g. `get_profile`).
 *   Deliberately no `ask` — it creates a durable Home turn and needs an authenticated org
 *   context the stateless lane does not resolve.
 * - Session Code Mode lane: `code` plus the home-surface tools named by
 *   SESSION_NATIVE_HOME_TOOL_IDS (exactly `ask`). Bootstrap helpers stay callable, unlisted.
 */

import { describe, expect, it } from "vite-plus/test";

import {
	compactCodeModeTools,
	extractRequestedCodeModeNamespaces,
} from "../codemode-fast-paths";
import { mcpToolsListResultTransform } from "../mcp-result-transform";
import { SESSION_NATIVE_HOME_TOOL_IDS } from "./code-mode-native-tools";
import { MAX_CODEMODE_DESCRIPTION_CHARS } from "./codemode-guidance";

function resolvedAppStub() {
	return {
		app: { slug: "tedix-unified", name: "Tedix" },
		metadata: { mcpConfig: { codeMode: true, authMode: "authenticated" } },
	} as never;
}

describe("outer-surface lanes", () => {
	it.each([undefined, "openai-mcp/1.0.0", "Claude", "Codex"])(
		"shares Connect tools and inputs with User-Agent %s",
		(userAgent) => {
			const tools = compactCodeModeTools(
				resolvedAppStub(),
				new Headers(userAgent ? { "User-Agent": userAgent } : {}),
				"connect",
			);
			expect(tools.map((tool) => tool.name)).toEqual(["code"]);
			expect(
				Object.keys(
					(tools[0]!.inputSchema as { properties: object }).properties,
				).sort(),
			).toEqual(["agentSessionId", "code", "invocation"]);
			expect(tools[0]!.description).toContain(
				"Run one async JavaScript function",
			);
			// Deck/Feed guidance lives in the server instructions, not the tool.
			expect(tools[0]!.description).not.toContain("show_deck");
			expect((tools[0]!.description as string).length).toBeLessThanOrEqual(
				MAX_CODEMODE_DESCRIPTION_CHARS,
			);
		},
	);

	it("omits payment from the actual Connect discovery schema", () => {
		const [code] = compactCodeModeTools(
			{ app: { slug: "connect", name: "Tedix" } } as never,
			new Headers(),
		);
		expect(code!.inputSchema).toMatchObject({ additionalProperties: false });
		expect(
			(code!.inputSchema as { properties: object }).properties,
		).not.toHaveProperty("payment");
	});
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
			expect(tools[0]?._meta).toEqual({
				securitySchemes,
				"com.tedix/structuredCall": { version: 1 },
			});
			expect(tools[0]?.securitySchemes).toEqual(securitySchemes);
			expect(tools[0]?.annotations).toEqual({
				readOnlyHint: false,
				destructiveHint: true,
				openWorldHint: true,
				title: "Code Mode",
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
					result: { tools: [{ name: "code", _meta: tools[0]?._meta }] },
				},
			} as never);
			if (!("result" in transformed))
				throw new Error("Expected tools/list result");
			const listed = transformed.result.tools as Array<Record<string, unknown>>;
			expect(listed[0]?.securitySchemes).toEqual(securitySchemes);
			expect(listed[0]?._meta).toEqual({
				securitySchemes,
				"com.tedix/structuredCall": { version: 1 },
			});
		},
	);
	it("stateless fast path advertises only code (no ask) independent of caller identity", () => {
		const tools = compactCodeModeTools(resolvedAppStub(), new Headers());
		expect(tools.map((tool) => tool.name)).toEqual(["code"]);
		for (const tool of tools)
			expect((tool.annotations as { title?: string }).title).toBe(tool.title);
	});

	it("lists bootstrap helpers only when configured as native opt-ins", () => {
		const tools = compactCodeModeTools(
			{
				app: { slug: "connect", name: "Tedix" },
				metadata: {
					mcpConfig: {
						codeMode: true,
						authMode: "authenticated",
						codeModeNativeTools: ["get_info", "get_profile"],
					},
				},
			} as never,
			new Headers(),
		);
		expect(tools.map((tool) => tool.name)).toEqual([
			"code",
			"get_info",
			"get_profile",
		]);
		for (const tool of tools)
			expect((tool.annotations as { title?: string }).title).toBe(tool.title);
	});

	it("session lane's native home surface is exactly ask", () => {
		expect([...SESSION_NATIVE_HOME_TOOL_IDS]).toEqual(["ask"]);
	});
	it("public apps do not advertise a personal account profile", () => {
		expect(
			compactCodeModeTools(
				{
					app: { name: "Public" },
					metadata: {
						mcpConfig: {
							codeMode: true,
							authMode: "public",
							codeModeNativeTools: ["get_info", "get_profile"],
						},
					},
				} as never,
				new Headers(),
			).map((t) => t.name),
		).toEqual(["code", "get_info"]);
	});
	it("session tools/list keeps code and ask and hides unlisted helpers and widgets", () => {
		const transform = mcpToolsListResultTransform(
			[{ toolId: "sample_read", authRequired: false }],
			{ codeMode: true, authMode: "authenticated" },
			new Headers({ "x-tedix-auth-type": "service" }),
		);
		const response = transform({
			request: { jsonrpc: "2.0", id: 1, method: "tools/list" },
			response: {
				jsonrpc: "2.0",
				id: 1,
				result: {
					tools: [
						{ name: "code" },
						{ name: "ask" },
						{ name: "get_info" },
						{ name: "get_profile" },
						{ name: "list_skills" },
						{ name: "read_skill" },
						{ name: "acme_unified_tedix__show_deck" },
					],
				},
			},
		} as never);
		if (!("result" in response)) throw new Error("Expected tools/list result");
		expect(
			(response.result.tools as Array<{ name: string }>).map((t) => t.name),
		).toEqual(["ask", "code"]);
	});
	it("preserves the standard account profile wire declaration without capability scope union", () => {
		const transform = mcpToolsListResultTransform(
			[],
			{ codeMode: true, codeModeNativeTools: ["get_profile"] },
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

describe("built-in compact native catalog", () => {
	function app(
		rows: unknown[] = [],
		mcpConfig: Record<string, unknown> = {},
		slug = "fictional-unified",
	) {
		return {
			app: { slug, name: "Fictional" },
			tools: rows,
			metadata: {
				mcpConfig: { codeMode: true, authMode: "authenticated", ...mcpConfig },
			},
		} as never;
	}
	const storedRow = {
		id: "fictional-stored-row",
		toolId: "search_native_tools",
		title: "Stored title",
		description: "Stored description",
		toolTypeId: "rpc",
		enabled: true,
		config: { transport: "catalog", endpoint: "catalog/search" },
		inputSchema: { type: "object", properties: {} },
		outputSchema: null,
		annotations: { readOnlyHint: true },
	};
	const headers = new Headers({
		"x-tedix-auth-type": "oauth",
		"x-tedix-auth-scopes": "mcp:catalog.read",
	});
	const names = (tools: Array<Record<string, unknown>>) =>
		tools.map((tool) => String(tool.name)).filter((name) => name !== "code");
	it("lists the code-built pair on every Code Mode gateway with its code-defined scope", () => {
		const [search, describe] = NATIVE_CATALOG_TOOLS;
		const tools = compactCodeModeTools(app(), headers);
		expect(names(tools)).toEqual(
			expect.arrayContaining(["search_native_tools", "get_native_tool_schema"]),
		);
		expect(
			tools.find((tool) => tool.name === "search_native_tools"),
		).toMatchObject({
			description: search!.description,
			inputSchema: search!.inputSchema,
			annotations: search!.annotations,
			securitySchemes: [{ type: "oauth2", scopes: ["mcp:catalog.read"] }],
			_meta: {
				"com.tedix/nativeCatalog": {
					version: 1,
					bootstrapTool: "get_info",
					endpoint: "catalog/search",
				},
			},
		});
		expect(
			tools.find((tool) => tool.name === "get_native_tool_schema"),
		).toMatchObject({ inputSchema: describe!.inputSchema });
	});
	it("ignores stored catalog rows instead of listing a duplicate", () => {
		const tools = compactCodeModeTools(app([storedRow]), headers);
		const listed = tools.filter((tool) => tool.name === "search_native_tools");
		expect(listed).toHaveLength(1);
		expect(listed[0]?.description).toBe(NATIVE_CATALOG_TOOLS[0]!.description);
	});
	it("withholds the pair from callers without the scope and from non-Code Mode, policy-mode or multi-org surfaces", () => {
		for (const [resolved, requestHeaders] of [
			[app(), new Headers()],
			[
				app(),
				new Headers({
					"x-tedix-auth-type": "oauth",
					"x-tedix-auth-scopes": "mcp:work.read",
				}),
			],
			[app([storedRow], { codeMode: false }), headers],
			[app([], { multiOrgConsent: true }, "connect"), headers],
			[app([], { enforcePolicies: true }), headers],
		] as const)
			expect(
				names(compactCodeModeTools(resolved, requestHeaders)).filter((name) =>
					name.includes("native"),
				),
			).toEqual([]);
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

it("hydrates the structured call namespace and keeps discovery helpers unbounded", async () => {
	const request = (invocation: unknown, code?: string) =>
		new Request("https://example.invalid/mcp", {
			method: "POST",
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "code", arguments: { invocation, code } },
			}),
		});
	expect(
		await extractRequestedCodeModeNamespaces(
			request({ callable: "work.list", args: {} }),
		),
	).toEqual(new Set(["work"]));
	expect(
		await extractRequestedCodeModeNamespaces(
			request({
				callable: "discover.describe",
				args: { callable: "work.list" },
			}),
		),
	).toBeNull();
	expect(
		await extractRequestedCodeModeNamespaces(
			request({ callable: "work.list", args: {} }, "async () => 1"),
		),
	).toEqual(new Set());
});
