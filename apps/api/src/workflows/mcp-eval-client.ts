import {
	FirstPartyMcpError,
	type FirstPartyMcpFetch,
	withFirstPartyMcp,
} from "../lib/first-party-mcp";

export interface McpEvalTool {
	name: string;
	description?: string;
	inputSchema?: Record<string, string | number | boolean | null | object>;
}

/**
 * Discover the app's Tedix MCP host and read its first `tools/list` page.
 *
 * The pinned SDK connect runs `server/discover` and rejects a host that does
 * not advertise 2026-07-28 with a `FirstPartyMcpError` of kind
 * `unsupported_protocol` — the one failure a retry cannot fix.
 */
export async function listMcpEvalTools(input: {
	fetch: FirstPartyMcpFetch;
	mcpUrl: string;
	mcpHost: string;
}): Promise<McpEvalTool[]> {
	try {
		return await withFirstPartyMcp(
			{
				url: input.mcpUrl,
				fetch: input.fetch,
				headers: { "X-Tedix-Host": input.mcpHost },
				clientName: "tedix-eval-runner",
				probe: true,
			},
			async (request) => {
				const listed = (await request("tools/list")) as {
					tools?: McpEvalTool[];
				};
				return listed.tools ?? [];
			},
		);
	} catch (error) {
		if (error instanceof FirstPartyMcpError && error.kind === "http") {
			throw new FirstPartyMcpError(
				`MCP HTTP ${error.status}: ${(error.body ?? "").slice(0, 200)}`,
				"http",
				error.status,
				undefined,
				error.body,
			);
		}
		throw error;
	}
}
