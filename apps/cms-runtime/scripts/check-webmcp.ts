import assert from "node:assert/strict";
import {
	ensureWebMcpBridge,
	handleWebMcpRequest,
	normalizeWebMcpToolPacks,
	WEBMCP_BRIDGE_PATH,
	WEBMCP_MCP_PATH,
	WEBMCP_PROTOCOL_VERSION,
	webMcpBridgeScriptResponse,
	type WebMcpOrgInfo,
} from "../src/webmcp";

const directOrg: WebMcpOrgInfo = {
	slug: "tedix",
	siteTitle: "Tedix",
	publicSiteUrl: "https://blog.tedix.dev",
	publicPathPrefix: null,
	webMcpToolPacks: ["site-search", "page-reader"],
};
const prefixedOrg: WebMcpOrgInfo = {
	slug: "acme",
	siteTitle: "Acme Guide",
	publicSiteUrl: "https://www.acme.example",
	publicPathPrefix: "/guide",
	webMcpToolPacks: ["site-search"],
};
const allowLimiter = {
	async limit() {
		return { success: true };
	},
};

function rpcRequest(
	url: string,
	method: "tools/list" | "tools/call",
	params: Record<string, unknown>,
	extra?: { name?: string; body?: Record<string, unknown> },
): Request {
	const headers: Record<string, string> = {
		"content-type": "application/json",
		"mcp-protocol-version": WEBMCP_PROTOCOL_VERSION,
		"mcp-method": method,
	};
	if (extra?.name) headers["mcp-name"] = extra.name;
	return new Request(url, {
		method: "POST",
		headers,
		body: JSON.stringify(
			extra?.body ?? {
				jsonrpc: "2.0",
				id: 1,
				method,
				params,
				_meta: {
					"io.modelcontextprotocol/protocolVersion": WEBMCP_PROTOCOL_VERSION,
					"io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
					"io.modelcontextprotocol/clientCapabilities": {},
				},
			},
		),
	});
}

// The served bridge is the shared @tedix/webmcp-core module: ES module
// configuration is derived from import.meta.url (never currentScript) and
// detection follows the current document API with a navigator fallback.
const bridgeSource = await (await webMcpBridgeScriptResponse()).text();
assert.match(bridgeSource, /import\.meta\.url/);
assert.doesNotMatch(bridgeSource, /document\.currentScript/);
assert.match(bridgeSource, /mcp-protocol-version/);
assert.match(bridgeSource, /navigator\.modelContext/);
assert.ok(
	bridgeSource.indexOf("document.modelContext") <
		bridgeSource.indexOf("navigator.modelContext"),
	"bridge must detect document.modelContext before navigator.modelContext",
);
assert.match(bridgeSource, /provideContext/);
assert.match(bridgeSource, /AbortController/);
assert.match(bridgeSource, new RegExp(WEBMCP_PROTOCOL_VERSION));

const directHtml = ensureWebMcpBridge(
	"<html><head></head><body></body></html>",
	directOrg,
);
assert.match(
	directHtml,
	/src="\/_tedix\/webmcp\/bridge\.js\?mcp-url=%2F_tedix%2Fwebmcp%2Fmcp"/,
);
assert.match(directHtml, /data-mcp-url="\/_tedix\/webmcp\/mcp"/);

const prefixedHtml = ensureWebMcpBridge(
	"<html><head></head><body></body></html>",
	prefixedOrg,
);
assert.match(
	prefixedHtml,
	/src="\/guide\/_tedix\/webmcp\/bridge\.js\?mcp-url=%2Fguide%2F_tedix%2Fwebmcp%2Fmcp"/,
);
assert.match(prefixedHtml, /data-mcp-url="\/guide\/_tedix\/webmcp\/mcp"/);
assert.equal(ensureWebMcpBridge(prefixedHtml, prefixedOrg), prefixedHtml);

assert.deepEqual(normalizeWebMcpToolPacks(undefined), [
	"site-search",
	"page-reader",
]);
assert.deepEqual(
	normalizeWebMcpToolPacks(["page-reader", "invalid", "page-reader"]),
	["page-reader"],
);
assert.deepEqual(normalizeWebMcpToolPacks("site-search"), []);

const listResponse = await handleWebMcpRequest(
	rpcRequest(`https://blog.tedix.dev${WEBMCP_MCP_PATH}`, "tools/list", {}),
	directOrg,
	WEBMCP_MCP_PATH,
	allowLimiter,
);
assert(listResponse);
assert.equal(listResponse.status, 200);
const listPayload = (await listResponse.json()) as {
	result: {
		resultType: string;
		tools: Array<{ name: string }>;
		ttlMs: number;
		cacheScope: string;
	};
};
assert.equal(listPayload.result.resultType, "complete");
assert.deepEqual(
	listPayload.result.tools.map((tool) => tool.name),
	["search_site", "read_page"],
);
assert.equal(listPayload.result.cacheScope, "public");
assert(listPayload.result.ttlMs > 0);

const prefixedList = await handleWebMcpRequest(
	rpcRequest(
		`https://www.acme.example/guide${WEBMCP_MCP_PATH}`,
		"tools/list",
		{},
	),
	prefixedOrg,
	WEBMCP_MCP_PATH,
	allowLimiter,
);
assert(prefixedList);
const prefixedListPayload = (await prefixedList.json()) as {
	result: { tools: Array<{ name: string }> };
};
assert.deepEqual(
	prefixedListPayload.result.tools.map((tool) => tool.name),
	["search_site"],
);

const disabledOrg = { ...directOrg, webMcpToolPacks: [] };
assert.equal(ensureWebMcpBridge("<head></head>", disabledOrg), "<head></head>");
const disabledEndpoint = await handleWebMcpRequest(
	rpcRequest(`https://blog.tedix.dev${WEBMCP_MCP_PATH}`, "tools/list", {}),
	disabledOrg,
	WEBMCP_MCP_PATH,
	allowLimiter,
);
assert.equal(disabledEndpoint?.status, 404);

let limiterKey = "";
const denied = await handleWebMcpRequest(
	rpcRequest(`https://blog.tedix.dev${WEBMCP_MCP_PATH}`, "tools/list", {}),
	directOrg,
	WEBMCP_MCP_PATH,
	{
		async limit({ key }) {
			limiterKey = key;
			return { success: false };
		},
	},
);
assert.equal(denied?.status, 429);
assert.equal(denied?.headers.get("retry-after"), "60");
assert.equal(limiterKey, "tedix:unknown");

const badHeaders = rpcRequest(
	`https://blog.tedix.dev${WEBMCP_MCP_PATH}`,
	"tools/list",
	{},
);
badHeaders.headers.set("mcp-method", "tools/call");
const badHeaderResponse = await handleWebMcpRequest(
	badHeaders,
	directOrg,
	WEBMCP_MCP_PATH,
	allowLimiter,
);
assert.equal(
	((await badHeaderResponse!.json()) as { error: { code: number } }).error.code,
	-32600,
);

const extraArgument = await handleWebMcpRequest(
	rpcRequest(
		`https://blog.tedix.dev${WEBMCP_MCP_PATH}`,
		"tools/call",
		{ name: "search_site", arguments: { query: "agents", extra: true } },
		{ name: "search_site" },
	),
	directOrg,
	WEBMCP_MCP_PATH,
	allowLimiter,
);
const extraPayload = (await extraArgument!.json()) as {
	result: { isError: boolean; content: Array<{ text: string }> };
};
assert.equal(extraPayload.result.isError, true);
assert.match(
	extraPayload.result.content[0]!.text,
	/query must be a string|Error/,
);

const oversized = new Request(`https://blog.tedix.dev${WEBMCP_MCP_PATH}`, {
	method: "POST",
	headers: {
		"content-type": "application/json",
		"content-length": "20000",
		"mcp-protocol-version": WEBMCP_PROTOCOL_VERSION,
		"mcp-method": "tools/list",
	},
	body: "{}",
});
const oversizedResponse = await handleWebMcpRequest(
	oversized,
	directOrg,
	WEBMCP_MCP_PATH,
	allowLimiter,
);
assert.equal(oversizedResponse?.status, 413);

const originalFetch = globalThis.fetch;
try {
	globalThis.fetch = (async () =>
		new Response(null, {
			status: 302,
			headers: { location: "https://attacker.example/sitemap.xml" },
		})) as typeof fetch;
	const redirectAttempt = await handleWebMcpRequest(
		rpcRequest(
			`https://www.acme.example/guide${WEBMCP_MCP_PATH}`,
			"tools/call",
			{ name: "search_site", arguments: { query: "planning" } },
			{ name: "search_site" },
		),
		prefixedOrg,
		WEBMCP_MCP_PATH,
		allowLimiter,
	);
	const redirectPayload = (await redirectAttempt!.json()) as {
		result: { isError: boolean; content: Array<{ text: string }> };
	};
	assert.equal(redirectPayload.result.isError, true);
	assert.match(
		redirectPayload.result.content[0]!.text,
		/public site and path prefix/,
	);

	let requestedUrl = "";
	globalThis.fetch = (async (input) => {
		requestedUrl = String(input);
		return new Response("not html", {
			status: 200,
			headers: { "content-type": "text/plain" },
		});
	}) as typeof fetch;
	const prefixedRead = await handleWebMcpRequest(
		rpcRequest(
			`https://www.acme.example/guide${WEBMCP_MCP_PATH}`,
			"tools/call",
			{ name: "read_page", arguments: { path: "/guide/vorsorge" } },
			{ name: "read_page" },
		),
		{ ...prefixedOrg, webMcpToolPacks: ["site-search", "page-reader"] },
		WEBMCP_MCP_PATH,
		allowLimiter,
	);
	assert.equal(requestedUrl, "https://www.acme.example/guide/vorsorge");
	assert.equal(
		((await prefixedRead!.json()) as { result: { isError: boolean } }).result
			.isError,
		true,
	);
} finally {
	globalThis.fetch = originalFetch;
}

const head = await handleWebMcpRequest(
	new Request(`https://blog.tedix.dev${WEBMCP_BRIDGE_PATH}`, {
		method: "HEAD",
	}),
	directOrg,
	WEBMCP_BRIDGE_PATH,
	allowLimiter,
);
assert.equal(head?.status, 200);
assert.equal(await head?.text(), "");

console.log(
	"✓ WebMCP module config, policy, protocol, limits, routing, and redirect bounds",
);
