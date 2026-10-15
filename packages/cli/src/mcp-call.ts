/**
 * `tedix mcp call` — send one raw MCP JSON-RPC request to the selected
 * workspace's gateway with the stored login, and print the JSON result.
 * The credential stays inside the client; nothing here reads or prints it.
 */

export const mcpUsage = (): string => `Tedix raw MCP request

Send one JSON-RPC request to the selected workspace's MCP gateway with the
stored login and print the JSON result. Use it for protocol methods that have
no dedicated command, such as events/list or events/poll. The token never
leaves the CLI process and is never printed.

Usage:
  tedix mcp call <method> [--params <json>] [--header <name=value>]...

Examples:
  tedix mcp call server/discover
  tedix mcp call events/list
  tedix -w tedix mcp call events/poll --params '{"cursor":"abc"}'
  tedix mcp call resources/read --params '{"uri":"skill://example"}' --organization acme

Options:
  --params <json>              Request params as a JSON object (default {})
  --header <name=value>        Add a request header; repeatable
  -w, --workspace <name>       Use a saved workspace's gateway and login
  --organization <target>      Target one authorized organization on Connect
                               (or set TEDIX_ORGANIZATION)
  --url <mcp-url>              Override the MCP gateway URL
  -h, --help                   Show this help

Authorization, Cookie and Tedix organization headers are refused; the CLI
sets authentication itself and --organization selects the organization.
`;

/** Headers the caller may not set: the login and target come from the CLI. */
const RESERVED_HEADERS = new Set([
	"authorization",
	"cookie",
	"proxy-authorization",
	"x-tedix-organization",
]);

const METHOD_PATTERN = /^[A-Za-z][\w.-]*(?:\/[\w.-]+)*$/;

export interface McpCallRequest {
	method: string;
	params: Record<string, unknown>;
	headers: Record<string, string>;
}

/** Validate `tedix mcp call` arguments into one JSON-RPC request. */
export function parseMcpCallRequest(input: {
	prompt?: string;
	params?: string;
	headers?: readonly string[];
}): McpCallRequest {
	const [verb, method, ...extra] = (input.prompt ?? "")
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	if (verb !== "call" || !method || extra.length > 0) {
		throw new Error(
			"Usage: tedix mcp call <method> [--params <json>] [--header <name=value>]",
		);
	}
	if (!METHOD_PATTERN.test(method)) {
		throw new Error(`Invalid MCP method "${method}"`);
	}
	let params: Record<string, unknown> = {};
	if (input.params !== undefined) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(input.params);
		} catch {
			throw new Error("--params must be valid JSON");
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("--params must be a JSON object");
		}
		params = parsed as Record<string, unknown>;
	}
	const headers: Record<string, string> = {};
	for (const entry of input.headers ?? []) {
		const equals = entry.indexOf("=");
		const name = equals > 0 ? entry.slice(0, equals).trim() : "";
		if (!name || !/^[!#$%&'*+.^`|~\w-]+$/.test(name)) {
			throw new Error(`--header must be <name=value>, got "${entry}"`);
		}
		if (RESERVED_HEADERS.has(name.toLowerCase())) {
			throw new Error(
				`--header ${name} is not allowed; the CLI sets it from the stored login and --organization`,
			);
		}
		headers[name] = entry.slice(equals + 1).trim();
	}
	return { method, params, headers };
}

export interface RawMcpClient {
	rawRequest(
		method: string,
		params: Record<string, unknown>,
		options: { headers?: Record<string, string>; signal?: AbortSignal },
	): Promise<unknown>;
}

/** Send the request and return the printable JSON result. */
export async function runMcpCall(
	client: RawMcpClient,
	request: McpCallRequest,
	signal?: AbortSignal,
): Promise<string> {
	const result = await client.rawRequest(request.method, request.params, {
		headers: request.headers,
		...(signal ? { signal } : {}),
	});
	return JSON.stringify(result ?? null, null, 2);
}
