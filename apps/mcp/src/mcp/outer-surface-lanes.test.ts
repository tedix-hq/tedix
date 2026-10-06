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
 *   SESSION_NATIVE_HOME_TOOL_IDS (exactly `ask`), plus authenticated profile bootstrap.
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
			const tools = compactCodeModeTools({
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
			} as never);
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
		const tools = compactCodeModeTools(resolvedAppStub());
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
			compactCodeModeTools({
				app: { name: "Public" },
				metadata: { mcpConfig: { codeMode: true, authMode: "public" } },
			} as never).map((t) => t.name),
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
