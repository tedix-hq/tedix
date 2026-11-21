import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { deriveToolWriteCapability } from "@tedix/api-contract/schemas/tools";
import { toolClassDeclarationGap } from "@tedix/api-contract/utils/tool-declared-class";

import { createMcpServer } from "@tedix/mcp-shared/server";
import { mountMcp } from "@tedix/mcp-shared/transport";
import {
	MCP_MODERN_PROTOCOL_VERSION,
	MCP_PROTOCOL_VERSION_META_KEY,
	MCP_CLIENT_CAPABILITIES_META_KEY,
} from "@tedix/mcp-shared/protocol";
import { buildInstructions } from "./agent/tools";
import { registerDeployTools } from "./agent/tools-deploy";
import type { SiteBuilderToolContext } from "./agent/tools-shared";
import { buildCmsMcpDiscovery, CMS_MCP_DISCOVERY } from "./mcp-discovery";

describe("CMS MCP discovery", () => {
	it("lists candidate tools with classifications accepted by catalog reconciliation", async () => {
		const server = createMcpServer({ name: "cms", version: "0.1.0" });
		registerDeployTools(server, {} as SiteBuilderToolContext);
		const response = await mountMcp(
			server,
			new Request("https://builder.example/mcp", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
					"MCP-Protocol-Version": MCP_MODERN_PROTOCOL_VERSION,
					"MCP-Method": "tools/list",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/list",
					params: {
						_meta: {
							[MCP_PROTOCOL_VERSION_META_KEY]: MCP_MODERN_PROTOCOL_VERSION,
							[MCP_CLIENT_CAPABILITIES_META_KEY]: {},
						},
					},
				}),
			}),
			{ route: "/mcp" },
		);
		expect(response.status).toBe(200);
		const { result } = z
			.object({
				result: z.object({
					tools: z.array(
						z.object({
							name: z.string(),
							annotations: z
								.object({
									readOnlyHint: z.boolean().optional(),
									destructiveHint: z.boolean().optional(),
								})
								.optional(),
							_meta: z.record(z.string(), z.unknown()).optional(),
						}),
					),
				}),
			})
			.parse(await response.json());
		for (const name of ["stage_theme", "get_theme_candidate"]) {
			const tool = result.tools.find((tool) => tool.name === name)!;
			expect(tool).toBeDefined();
			const writeCapability = deriveToolWriteCapability(tool.annotations);
			expect(writeCapability).toBe(name === "stage_theme" ? "write" : "read");
			expect(
				toolClassDeclarationGap({ writeCapability, meta: tool._meta }),
			).toBeNull();
		}
	});

	it("advertises the Site Builder identity and implemented capabilities", () => {
		expect(CMS_MCP_DISCOVERY.serverInfo.name).toBe("Tedix Site Builder MCP");
		expect(CMS_MCP_DISCOVERY.capabilities).toEqual({ tools: {} });
		expect(CMS_MCP_DISCOVERY.capabilities).not.toHaveProperty("resources");
		expect(CMS_MCP_DISCOVERY.capabilities).not.toHaveProperty("prompts");
	});
});

describe("CMS modern transport instructions", () => {
	it.each(["tedix", "marketing"] as const)(
		"publishes canonical %s instructions through server/discover",
		async (template) => {
			const instructions = buildInstructions(template);
			const server = createMcpServer(
				{ name: "cms", version: "0.1.0" },
				{ instructions },
			);
			const response = await mountMcp(
				server,
				new Request("https://builder.tedix.dev/mcp", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Accept: "application/json, text/event-stream",
						"MCP-Protocol-Version": MCP_MODERN_PROTOCOL_VERSION,
						"MCP-Method": "server/discover",
					},
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						method: "server/discover",
						params: {
							_meta: {
								[MCP_PROTOCOL_VERSION_META_KEY]: MCP_MODERN_PROTOCOL_VERSION,
								[MCP_CLIENT_CAPABILITIES_META_KEY]: {},
							},
						},
					}),
				}),
				{ route: "/mcp", discover: buildCmsMcpDiscovery(instructions) },
			);
			expect(response.status).toBe(200);
			const body = z
				.object({ result: z.object({ instructions: z.string() }) })
				.parse(await response.json());
			expect(body.result.instructions).toBe(instructions);
			expect(body.result.instructions).toContain(
				"getSiteSettings() → { title, tagline, url, ... }",
			);
			expect(body.result.instructions).toContain(
				"getSiteSettingsWithCacheHint() → { data, cacheHint }",
			);
			expect(body.result.instructions).toContain(
				"search(query, opts) → { items, nextCursor? }",
			);
			expect(body.result.instructions).toContain(
				"Pass returned cacheHint values",
			);
			expect(body.result.instructions).not.toContain("emdash-lead-form");
			expect(body.result.instructions).not.toContain("site_title");
		},
	);
});
