/** Shared context and Emdash MCP handshake fixtures for the CMS proxy suites. */
import { buildCmsAuthHeaderCandidates } from "../cms-proxy-auth";
import { type CmsProxyContext } from "../cms-proxy-runtime";

export const baseContext: CmsProxyContext = {
	orgSlug: "tedix",
	forwardedAuth: undefined,
	serviceApiKey: undefined,
	internalAuthToken: undefined,
	environment: "production",
};

export const buildCmsAuthHeaders = (ctx: CmsProxyContext) =>
	buildCmsAuthHeaderCandidates(ctx)[0]?.headers ?? null;

/**
 * The connection handshake of a released (2025-era, stateless) Emdash MCP
 * endpoint, as its official SDK WebStandardStreamableHTTPServerTransport
 * answers it: the 2026 `server/discover` probe is rejected with HTTP 400,
 * `initialize` succeeds, `notifications/initialized` is accepted. Returns
 * undefined for anything else (`tools/call`), which the test answers.
 * `tenant-mcp-emdash.test.ts` drives the real route end to end.
 */
export function emdashMcpHandshake(body: {
	id?: unknown;
	method?: unknown;
}): Response | undefined {
	if (body.method === "server/discover") {
		return Response.json(
			{
				jsonrpc: "2.0",
				error: {
					code: -32000,
					message:
						"Bad Request: Unsupported protocol version: 2026-07-28 (supported versions: 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07)",
				},
				id: null,
			},
			{ status: 400 },
		);
	}
	if (body.method === "initialize") {
		return Response.json({
			jsonrpc: "2.0",
			id: body.id,
			result: {
				protocolVersion: "2025-11-25",
				capabilities: { tools: {} },
				serverInfo: { name: "emdash", version: "1.0.1" },
			},
		});
	}
	if (body.method === "notifications/initialized") {
		return new Response(null, { status: 202 });
	}
	return undefined;
}

export const EMDASH_HANDSHAKE = [
	"server/discover",
	"initialize",
	"notifications/initialized",
] as const;
