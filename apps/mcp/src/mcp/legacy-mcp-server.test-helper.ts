const SUPPORTED_PROTOCOL_VERSIONS = [
	"2025-11-25",
	"2025-06-18",
	"2025-03-26",
	"2024-11-05",
	"2024-10-07",
];

type ToolResult = { content: { type: "text"; text: string }[] };

export type LegacyMcpTools = Record<
	string,
	(args: Record<string, unknown>) => ToolResult | Promise<ToolResult>
>;

function rpcResponse(status: number, body: Record<string, unknown>) {
	return Response.json({ jsonrpc: "2.0", ...body }, { status });
}

/**
 * A stateless 2025-era Streamable HTTP MCP server, written against the wire
 * format so the suite does not depend on the end-of-life v1 SDK. It answers
 * the handshake and `tools/call` as that SDK's JSON-response transport did:
 * any request other than `initialize` carrying an `MCP-Protocol-Version` it
 * does not know (the 2026 `server/discover` probe included) gets HTTP 400.
 */
export async function serveLegacyMcp(
	request: Request,
	serverInfo: { name: string; version: string },
	tools: LegacyMcpTools,
): Promise<Response> {
	if (request.method !== "POST")
		return rpcResponse(405, {
			error: { code: -32000, message: "Method not allowed." },
			id: null,
		});
	const message = (await request.json()) as {
		id?: string | number;
		method: string;
		params?: {
			protocolVersion?: string;
			name?: string;
			arguments?: Record<string, unknown>;
		};
	};
	const { id, method, params } = message;
	const version = request.headers.get("mcp-protocol-version");
	if (
		method !== "initialize" &&
		version !== null &&
		!SUPPORTED_PROTOCOL_VERSIONS.includes(version)
	)
		return rpcResponse(400, {
			error: {
				code: -32000,
				message: `Bad Request: Unsupported protocol version: ${version} (supported versions: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")})`,
			},
			id: null,
		});
	if (id === undefined) return new Response(null, { status: 202 });
	if (method === "initialize") {
		const requested = params?.protocolVersion;
		return rpcResponse(200, {
			id,
			result: {
				protocolVersion:
					requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
						? requested
						: SUPPORTED_PROTOCOL_VERSIONS[0],
				capabilities: { tools: { listChanged: true } },
				serverInfo,
			},
		});
	}
	const tool = method === "tools/call" ? tools[params?.name ?? ""] : undefined;
	if (!tool)
		return rpcResponse(200, {
			id,
			error:
				method === "tools/call"
					? { code: -32602, message: `Tool ${params?.name} not found` }
					: { code: -32601, message: "Method not found" },
		});
	return rpcResponse(200, { id, result: await tool(params?.arguments ?? {}) });
}
