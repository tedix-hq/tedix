/// <reference types="@cloudflare/vitest-plugin/types" />

import type { ToolConfig } from "@tedix/api-contract/schemas/tools";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { type ToolExecutionContext, ToolHandler } from "./handler";
import { resetUpstreamEraCache } from "./upstream-mcp-client";

// Served by test/fixtures/upstream-mcp.ts on Miniflare's outboundService.
const LEGACY_UPSTREAM_URL = "https://legacy-upstream.example.com/mcp";
const MODERN_UPSTREAM_URL = "https://modern-upstream.example.com/mcp";

function upstreamCtx(mcpServerUrl: string): ToolExecutionContext<ToolConfig> {
	return {
		appId: "app_1",
		app: {
			id: "app_1",
			slug: "external-app",
			name: "External App",
			organizationId: "org_1",
		} as ToolExecutionContext["app"],
		appCapabilities: {},
		env: { ENVIRONMENT: "test" } as unknown as CloudflareEnv,
		config: {
			transport: "mcp",
			mcpServerUrl,
			mcpToolName: "echo",
		} as unknown as ToolConfig,
		toolId: "echo",
		requestId: "req_1",
		callerIdentity: { authType: "oauth", organizationId: "org_1" },
	};
}

// No stub stands in for fetch here: the proxied call leaves through workerd's
// native global fetch, which throws "Illegal invocation" when invoked with a
// foreign receiver (the 2026-09-29 outage every Node test passed through).
describe("external MCP proxy on workerd's native fetch", () => {
	beforeEach(() => resetUpstreamEraCache());

	it.each([
		["a 2025-era SDK v1 server", LEGACY_UPSTREAM_URL],
		["a 2026-07-28 mountMcp server", MODERN_UPSTREAM_URL],
	])("proxies a tool call to %s", async (_server, url) => {
		const handler = new ToolHandler();
		for (const msg of ["negotiated", "cached-era"]) {
			expect(await handler.execute({ msg }, upstreamCtx(url))).toMatchObject({
				status: 200,
				data: { echoed: msg },
			});
		}
	});
});
