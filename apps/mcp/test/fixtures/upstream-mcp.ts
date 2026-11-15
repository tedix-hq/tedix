import { createMcpServer } from "@tedix/mcp-shared/server";
import { mountMcp } from "@tedix/mcp-shared/transport";
import * as z from "zod";
import { serveLegacyMcp } from "../../src/mcp/legacy-mcp-server.test-helper";

/**
 * External MCP servers for the workerd suite. They run on the Node side of
 * Miniflare's `outboundService`, so a Worker reaches them only through
 * workerd's native global `fetch` — the binding that rejects a foreign `this`.
 */
export const LEGACY_UPSTREAM_URL = "https://legacy-upstream.example.com/mcp";
export const MODERN_UPSTREAM_URL = "https://modern-upstream.example.com/mcp";

const echoResult = ({ msg }: { msg: string }) => ({
	content: [{ type: "text" as const, text: JSON.stringify({ echoed: msg }) }],
});

/** A 2025-era server: the v1 SDK's stateless web-standard wire behavior. */
function serveLegacyV1(request: Request): Promise<Response> {
	return serveLegacyMcp(
		request,
		{ name: "legacy", version: "1.0.0" },
		{ echo: ({ msg }) => echoResult({ msg: String(msg) }) },
	);
}

/** A 2026-07-28 server mounted the way Tedix's own MCP Workers mount one. */
async function serveModern(request: Request): Promise<Response> {
	const server = createMcpServer({ name: "modern", version: "1.0.0" });
	server.registerTool(
		"echo",
		{ inputSchema: { msg: z.string() } },
		async (args) => echoResult(args),
	);
	return mountMcp(server, request, {
		route: null,
		discover: {
			serverInfo: { name: "modern", version: "1.0.0" },
			capabilities: { tools: {} },
		},
	});
}

/** Miniflare `outboundService`: serve the fixture upstreams, refuse the rest. */
export async function upstreamOutbound(request: Request): Promise<Response> {
	const { origin, pathname } = new URL(request.url);
	const route = `${origin}${pathname}`;
	if (route === LEGACY_UPSTREAM_URL) return serveLegacyV1(request);
	if (route === MODERN_UPSTREAM_URL) return serveModern(request);
	return new Response("External network disabled in MCP workerd tests", {
		status: 599,
	});
}
