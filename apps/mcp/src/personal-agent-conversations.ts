import { getApiClient } from "./lib/api-client";

/** Signed-out protocol entry; never forwards cookies, OAuth tokens, or caller headers. */
export async function handlePersonalAgentConversations(input: {
	request: Request;
	appId: string;
	organizationId: string;
	env: CloudflareEnv;
}) {
	const { request, appId, organizationId, env } = input;
	const headers = { "Cache-Control": "private, no-store" };
	if (!["POST", "GET"].includes(request.method))
		return new Response(null, {
			status: 405,
			headers: { ...headers, Allow: "GET, POST" },
		});
	let body;
	if (request.method === "POST") {
		if (
			request.headers.get("Content-Type")?.split(";")[0]?.trim() !==
			"application/json"
		)
			return Response.json(
				{ error: "invalid_request" },
				{ status: 400, headers },
			);
		try {
			const reader = request.body?.getReader();
			if (!reader) throw new Error("Missing body");
			let size = 0;
			const chunks: Uint8Array[] = [];
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					size += value.byteLength;
					if (size > 32768) throw new Error("Body too large");
					chunks.push(value);
				}
			} finally {
				await reader.cancel();
				reader.releaseLock();
			}
			const bytes = new Uint8Array(size);
			let offset = 0;
			for (const chunk of chunks) {
				bytes.set(chunk, offset);
				offset += chunk.byteLength;
			}
			body = JSON.parse(new TextDecoder().decode(bytes));
		} catch {
			return Response.json(
				{ error: "invalid_request" },
				{ status: 400, headers },
			);
		}
	}
	const token = request.headers.get("Poppy-Session");
	const version = request.headers.get("Poppy-Version");
	try {
		const client = getApiClient({
			serviceFetch: env.API_SERVICE,
			orgId: organizationId,
		});
		const result = await client.osTenant.personalAgentConversation({
			organizationId,
			appId,
			url: request.url,
			method: request.method,
			sessionToken: token && token.length <= 16384 ? token : null,
			version: version && version.length <= 32 ? version : null,
			...(body !== undefined ? { body } : {}),
		});
		return Response.json(result.body, {
			status: result.httpStatus,
			headers: {
				...headers,
				...(result.httpStatus === 429 ? { "Retry-After": "60" } : {}),
			},
		});
	} catch {
		return Response.json({ error: "unavailable" }, { status: 503, headers });
	}
}
