import {
	Client,
	StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

export const HOT_THEME_MCP_CLIENT_NAME = "tedix-cms-hot-theme-validate";
export const HOT_THEME_MCP_TIMEOUT_MS = 45_000;
const USER_AGENT = "tedix-cms-hot-theme-validate/1.0";

export type HotThemeMcpFetch = (
	url: string,
	init: RequestInit,
) => Promise<Response>;

/**
 * Connect the hot-theme validator to the Site Builder MCP endpoint through the
 * SDK v2 client pinned to 2026-07-28: the connect runs `server/discover` and
 * fails unless the endpoint advertises that revision. The SDK binds the
 * per-request `_meta` envelope and the `MCP-Protocol-Version` / `Mcp-Method` /
 * `Mcp-Name` headers on every request.
 */
export async function connectHotThemeMcp(
	mcpUrl: string,
	headers: Record<string, string>,
	fetchFn: HotThemeMcpFetch = globalThis.fetch.bind(globalThis),
): Promise<Client> {
	const client = new Client(
		{ name: HOT_THEME_MCP_CLIENT_NAME, version: "1.0.0" },
		{
			versionNegotiation: { mode: { pin: "2026-07-28" } },
			inputRequired: { autoFulfill: false },
		},
	);
	const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
		fetch: async (input, init) => {
			// A validator never listens for server-initiated messages.
			if (init?.method === "GET") return new Response(null, { status: 405 });
			const merged = new Headers(init?.headers);
			for (const [name, value] of Object.entries(headers))
				merged.set(name, value);
			if (!merged.has("User-Agent")) merged.set("User-Agent", USER_AGENT);
			const signal = AbortSignal.timeout(HOT_THEME_MCP_TIMEOUT_MS);
			return fetchFn(String(input), {
				...init,
				headers: merged,
				redirect: "follow",
				signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
			});
		},
	});
	await client.connect(transport, { timeout: HOT_THEME_MCP_TIMEOUT_MS });
	return client;
}

/** Run one Code Mode program through the endpoint's `code` tool. */
export async function callHotThemeCode(
	client: Client,
	code: string,
): Promise<Record<string, unknown>> {
	return (await client.callTool(
		{ name: "code", arguments: { code } },
		{
			timeout: HOT_THEME_MCP_TIMEOUT_MS,
			// Sent once: the explicit definition disables the -32020 resend.
			toolDefinition: { name: "code", inputSchema: { type: "object" } },
		},
	)) as Record<string, unknown>;
}
