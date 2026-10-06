import { McpServer as LegacyMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { ToolConfig } from "@tedix/api-contract/schemas/tools";
import { createMcpServer } from "@tedix/mcp-shared/server";
import { mountMcp, type MountMcpOptions } from "@tedix/mcp-shared/transport";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import * as z from "zod";
import { type ToolExecutionContext, ToolHandler } from "./handler";
import { resetUpstreamEraCache } from "./upstream-mcp-client";

// End-to-end: ToolHandler's MCP transport against real in-process servers.
// The proxied URL is external (no service binding), so every hop goes through
// the global fetch the Worker uses in production.
const UPSTREAM_URL = "https://upstream.example.com/mcp";

type Exchange = { method: string; rpc: string | undefined; status: number };

function upstreamCtx(): ToolExecutionContext<ToolConfig> {
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
			mcpServerUrl: UPSTREAM_URL,
			mcpToolName: "echo",
			auth: { type: "header", header: "X-Upstream-Key", value: "k_1" },
		} as unknown as ToolConfig,
		toolId: "echo",
		requestId: "req_1",
		callerIdentity: { authType: "oauth", organizationId: "org_1" },
	};
}

/** Route the Worker's global fetch into one in-process MCP endpoint. */
function serveUpstream(handle: (request: Request) => Promise<Response>) {
	const exchanges: Exchange[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			expect(request.url).toBe(UPSTREAM_URL);
			expect(request.headers.get("X-Upstream-Key")).toBe("k_1");
			const rpc =
				request.method === "POST"
					? ((await request.clone().json()) as { method?: string }).method
					: undefined;
			let response: Response;
			try {
				response = await handle(request);
			} catch (error) {
				// A dropped connection: recorded as status 0, surfaced as fetch does.
				exchanges.push({ method: request.method, rpc, status: 0 });
				throw error;
			}
			exchanges.push({ method: request.method, rpc, status: response.status });
			return response;
		}),
	);
	return exchanges;
}

/** The official v1 SDK's stateless web-standard transport. */
async function serveLegacyV1(request: Request): Promise<Response> {
	const server = new LegacyMcpServer({ name: "legacy", version: "1.0.0" });
	server.registerTool(
		"echo",
		{ inputSchema: { msg: z.string() } },
		async ({ msg }) => ({
			content: [{ type: "text", text: JSON.stringify({ echoed: msg }) }],
		}),
	);
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	});
	await server.connect(transport);
	return transport.handleRequest(request);
}

/** A v1 server whose front end mishandles the unknown discovery probe. */
function probeRejectingV1(onProbe: () => Promise<Response>) {
	return async (request: Request) => {
		const rpc =
			request.method === "POST"
				? ((await request.clone().json()) as { method?: string }).method
				: undefined;
		return rpc === "server/discover" ? onProbe() : serveLegacyV1(request);
	};
}

async function callEcho(msg: string) {
	return new ToolHandler().execute({ msg }, upstreamCtx());
}

describe("MCP transport against real upstream servers", () => {
	beforeEach(() => resetUpstreamEraCache());
	afterEach(() => vi.unstubAllGlobals());

	it("negotiates a 2025-era SDK v1 server once, then skips the probe", async () => {
		// The shape of every released 2025-era upstream (Emdash included).
		const exchanges = serveUpstream(serveLegacyV1);

		expect(await callEcho("one")).toMatchObject({
			status: 200,
			data: { echoed: "one" },
		});
		// The v1 transport rejects the 2026 probe with HTTP 400 "Unsupported
		// protocol version": a legacy signal, not a failure.
		expect(exchanges).toEqual([
			{ method: "POST", rpc: "server/discover", status: 400 },
			{ method: "POST", rpc: "initialize", status: 200 },
			{ method: "POST", rpc: "notifications/initialized", status: 202 },
			{ method: "POST", rpc: "tools/call", status: 200 },
		]);

		exchanges.length = 0;
		expect(await callEcho("two")).toMatchObject({
			status: 200,
			data: { echoed: "two" },
		});
		expect(exchanges).toEqual([
			{ method: "POST", rpc: "initialize", status: 200 },
			{ method: "POST", rpc: "notifications/initialized", status: 202 },
			{ method: "POST", rpc: "tools/call", status: 200 },
		]);
	});

	it.each<[string, () => Promise<Response>, number]>([
		[
			"answers the probe with HTTP 500",
			async () => new Response("internal error", { status: 500 }),
			500,
		],
		[
			"resets the connection on the probe",
			async () => {
				throw new TypeError("Network connection lost.");
			},
			0,
		],
	])(
		"falls back to initialize when a v1 server %s, then caches legacy",
		async (_case, onProbe, probeStatus) => {
			const exchanges = serveUpstream(probeRejectingV1(onProbe));

			expect(await callEcho("one")).toMatchObject({
				status: 200,
				data: { echoed: "one" },
			});
			expect(exchanges).toEqual([
				{ method: "POST", rpc: "server/discover", status: probeStatus },
				{ method: "POST", rpc: "initialize", status: 200 },
				{ method: "POST", rpc: "notifications/initialized", status: 202 },
				{ method: "POST", rpc: "tools/call", status: 200 },
			]);

			exchanges.length = 0;
			expect(await callEcho("two")).toMatchObject({
				status: 200,
				data: { echoed: "two" },
			});
			expect(exchanges.map((exchange) => exchange.rpc)).toEqual([
				"initialize",
				"notifications/initialized",
				"tools/call",
			]);
		},
	);

	it("invokes the global fetch without a foreign receiver, as workerd requires", async () => {
		serveUpstream(serveLegacyV1);
		const inner = globalThis.fetch;
		// workerd's native fetch throws when called as a method of another object.
		vi.stubGlobal(
			"fetch",
			function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
				if (this !== undefined && this !== globalThis) {
					throw new TypeError(
						"Illegal invocation: function called with incorrect `this` reference.",
					);
				}
				return inner(input, init);
			},
		);

		expect(await callEcho("bound")).toMatchObject({
			status: 200,
			data: { echoed: "bound" },
		});
	});

	it("does not cache legacy when the fallback handshake also fails", async () => {
		const exchanges = serveUpstream(
			async () => new Response("internal error", { status: 500 }),
		);

		expect(await callEcho("one")).toMatchObject({ status: 500 });
		expect(exchanges.map((exchange) => exchange.rpc)).toEqual([
			"server/discover",
			"initialize",
		]);

		exchanges.length = 0;
		await callEcho("two");
		expect(exchanges[0]?.rpc).toBe("server/discover");
	});

	it("keeps a 401 probe answer an auth failure without a legacy retry", async () => {
		const exchanges = serveUpstream(
			probeRejectingV1(
				async () => new Response("unauthorized", { status: 401 }),
			),
		);

		expect(await callEcho("one")).toMatchObject({ status: 401 });
		expect(exchanges.map((exchange) => exchange.rpc)).toEqual([
			"server/discover",
		]);
	});

	it.each<[string, MountMcpOptions]>([
		// apps/docs: a simple mount served by the SDK's createMcpHandler engine.
		["SDK engine", {}],
		// apps/tedi-runtime: an extension mount served by the Tedix transport.
		["Tedix transport", { requiredClientExtensions: [] }],
	])(
		"calls a 2026-07-28 server (%s) statelessly and remembers the era",
		async (_engine, mountOptions) => {
			const exchanges = serveUpstream(async (request) => {
				const server = createMcpServer({ name: "modern", version: "1.0.0" });
				server.registerTool(
					"echo",
					{ inputSchema: { msg: z.string() } },
					async ({ msg }) => ({
						content: [{ type: "text", text: JSON.stringify({ echoed: msg }) }],
					}),
				);
				return mountMcp(server, request, {
					route: null,
					discover: {
						serverInfo: { name: "modern", version: "1.0.0" },
						capabilities: { tools: {} },
					},
					...mountOptions,
				});
			});

			expect(await callEcho("one")).toMatchObject({
				status: 200,
				data: { echoed: "one" },
			});
			expect(exchanges).toEqual([
				{ method: "POST", rpc: "server/discover", status: 200 },
				{ method: "POST", rpc: "tools/call", status: 200 },
			]);

			exchanges.length = 0;
			expect(await callEcho("two")).toMatchObject({
				status: 200,
				data: { echoed: "two" },
			});
			expect(exchanges).toEqual([
				{ method: "POST", rpc: "tools/call", status: 200 },
			]);
		},
	);
});
