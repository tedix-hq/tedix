import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

/** In-process fictional upstream for cross-service policy integration tests. */
export function fictionalPolicyProvider(state: {
	account: string;
	writes: number;
}): typeof fetch {
	return async (input, init) => {
		const request = new Request(input, init);
		if (request.headers.get("Authorization") !== "Bearer fictional-token")
			return new Response("Unauthorized", { status: 401 });
		const server = new McpServer({ name: "fictional-provider", version: "1" });
		server.registerTool("identity", { inputSchema: {} }, async () => ({
			content: [
				{
					type: "text",
					text: JSON.stringify({ account: { id: state.account } }),
				},
			],
		}));
		server.registerTool("write", { inputSchema: {} }, async () => {
			state.writes++;
			return { content: [{ type: "text", text: "ok" }] };
		});
		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
			enableJsonResponse: true,
		});
		await server.connect(transport);
		return transport.handleRequest(request);
	};
}
