import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
	ensureWebMcpBridge,
	handleWebMcpRequest,
	WEBMCP_BRIDGE_PATH,
	WEBMCP_MCP_PATH,
	WEBMCP_PROTOCOL_VERSION,
	webMcpBridgeScriptResponse,
	type WebMcpOrgInfo,
} from "../src/webmcp";

const workspace = fileURLToPath(new URL("..", import.meta.url));
const schemaPath = fileURLToPath(
	new URL("../webmcp-evals/schema.json", import.meta.url),
);
const evalsPath = fileURLToPath(
	new URL("../webmcp-evals/evals.json", import.meta.url),
);

let origin = "";
const org = (): WebMcpOrgInfo => ({
	slug: "tedix",
	siteTitle: "Tedix",
	publicSiteUrl: origin,
	publicPathPrefix: null,
	webMcpToolPacks: ["site-search", "page-reader"],
});
const limiter = {
	async limit() {
		return { success: true };
	},
};

const server = Bun.serve({
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === WEBMCP_BRIDGE_PATH)
			return webMcpBridgeScriptResponse(request.method === "HEAD");
		if (url.pathname === WEBMCP_MCP_PATH)
			return (
				(await handleWebMcpRequest(request, org(), WEBMCP_MCP_PATH, limiter)) ??
				new Response("Not found", { status: 404 })
			);
		if (url.pathname === "/_tedix/search.json")
			return Response.json({
				data: {
					items: [
						{
							collection: "posts",
							id: "agents",
							title: "Agents, apps, and work",
							url: `${origin}/blog/agents`,
							snippet: "How agents and people share work in Tedix.",
						},
					],
				},
			});
		if (url.pathname === "/blog/agents")
			return new Response(
				"<!doctype html><title>Agents, apps, and work</title><body><main><h1>Agents, apps, and work</h1><p>Agents and people share project information, tasks, and results in Tedix.</p></main></body>",
				{ headers: { "content-type": "text/html; charset=utf-8" } },
			);
		if (url.pathname === "/")
			return new Response(
				ensureWebMcpBridge(
					"<!doctype html><html><head><title>Tedix CMS eval fixture</title></head><body></body></html>",
					org(),
				),
				{ headers: { "content-type": "text/html; charset=utf-8" } },
			);
		return new Response("Not found", { status: 404 });
	},
});
origin = server.url.origin;

function listRequest(): Request {
	return new Request(`${origin}${WEBMCP_MCP_PATH}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"mcp-method": "tools/list",
			"mcp-protocol-version": WEBMCP_PROTOCOL_VERSION,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/list",
			params: {},
			_meta: {
				"io.modelcontextprotocol/protocolVersion": WEBMCP_PROTOCOL_VERSION,
				"io.modelcontextprotocol/clientInfo": {
					name: "webmcp-evals-ci",
					version: "1",
				},
				"io.modelcontextprotocol/clientCapabilities": {},
			},
		}),
	});
}

try {
	const response = await handleWebMcpRequest(
		listRequest(),
		org(),
		WEBMCP_MCP_PATH,
		limiter,
	);
	assert(response);
	const payload = (await response.json()) as {
		result: { tools: unknown[] };
	};
	const schema = JSON.parse(await readFile(schemaPath, "utf8")) as {
		tools: unknown[];
	};
	assert.deepEqual(
		schema.tools,
		payload.result.tools,
		"webmcp-evals/schema.json must match the CMS tools/list response",
	);

	const child = spawn(
		"bunx",
		[
			"webmcp-evals",
			"--chrome-channel",
			"chrome",
			"smoke",
			"--url",
			origin,
			"--evals",
			evalsPath,
			"--verbose",
		],
		{ cwd: workspace, stdio: "inherit" },
	);
	const code = await new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", resolve);
	});
	assert.equal(code, 0, "webmcp-evals smoke failed");
} finally {
	await server.stop(true);
}
