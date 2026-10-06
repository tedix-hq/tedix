import {
	callRpc,
	RpcCallError,
	serviceBindingFetch,
} from "@tedix/api-client/internal";

interface ApiRpcEnv {
	API_SERVICE?: Fetcher;
	API_URL: string;
}

function decodeErrorDetail(detail: string): unknown {
	try {
		const parsed = JSON.parse(detail) as unknown;
		if (parsed && typeof parsed === "object" && "json" in parsed) {
			return (parsed as { json: unknown }).json;
		}
		return parsed;
	} catch {
		return detail;
	}
}

/**
 * Dynamic MCP-to-API call that retains HTTP status for task protocol mapping.
 * Static application code should use the typed internal client instead.
 */
export async function callApiRpc(
	env: ApiRpcEnv,
	path: string,
	input: unknown,
	options: {
		headers?: Record<string, string>;
		serviceBinding?: boolean;
		timeoutMs?: number;
		signal?: AbortSignal;
	} = {},
): Promise<{ data: unknown; status: number }> {
	const useServiceBinding =
		(options.serviceBinding ?? true) && Boolean(env.API_SERVICE);
	try {
		const data = await callRpc(path, input, {
			apiUrl: useServiceBinding ? "https://api" : env.API_URL,
			fetch: useServiceBinding
				? serviceBindingFetch(env.API_SERVICE!)
				: undefined,
			headers: {
				...(useServiceBinding ? { "X-Service-Binding": "true" } : {}),
				...options.headers,
			},
			timeoutMs: options.timeoutMs,
			signal: options.signal,
		});
		return { data, status: 200 };
	} catch (error) {
		if (error instanceof RpcCallError) {
			return { data: decodeErrorDetail(error.detail), status: error.status };
		}
		throw error;
	}
}
