import {
	callRpc,
	serviceBindingFetch,
	type FetcherLike,
	RpcCallError,
} from "@tedix/api-client/internal";
export async function createTediConsoleSession(
	request: Request,
	api?: FetcherLike,
): Promise<Response> {
	const headers = {
		"Cache-Control": "no-store",
		"Referrer-Policy": "no-referrer",
	};
	if (request.method !== "POST")
		return new Response("Method Not Allowed", {
			status: 405,
			headers: { ...headers, Allow: "POST" },
		});
	// Only a machine's explicit bearer credential is relayed. Ambient human cookies and trust headers never cross this boundary.
	const authorization = request.headers.get("Authorization");
	if (!authorization?.match(/^Bearer \S+$/i))
		return new Response("Tedi bearer token required", { status: 401, headers });
	if (!api)
		return new Response("Console session service unavailable", {
			status: 503,
			headers,
		});
	try {
		const result = await callRpc<{ sessionToken: string; expiresAt: number }>(
			"tediConsole/createSession",
			{},
			{
				apiUrl: "https://api",
				fetch: serviceBindingFetch(api),
				headers: { Authorization: authorization },
				retry: 0,
			},
		);
		return Response.json(result, { headers });
	} catch (error) {
		return new Response("Console session refused", {
			status:
				error instanceof RpcCallError &&
				error.status >= 400 &&
				error.status < 500
					? error.status
					: 503,
			headers,
		});
	}
}
