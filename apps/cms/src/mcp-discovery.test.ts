import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { createMcpServer } from "@tedix/mcp-shared/server";
import { mountMcp } from "@tedix/mcp-shared/transport";
import {
	MCP_MODERN_PROTOCOL_VERSION,
	MCP_PROTOCOL_VERSION_META_KEY,
	MCP_CLIENT_CAPABILITIES_META_KEY,
} from "@tedix/mcp-shared/protocol";
import { buildInstructions } from "./agent/tools";
import { buildCmsMcpDiscovery, CMS_MCP_DISCOVERY } from "./mcp-discovery";

describe("CMS MCP discovery", () => {
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
