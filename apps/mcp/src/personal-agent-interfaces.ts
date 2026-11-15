import { PersonalAgentFeedbackSchema } from "@tedix/api-contract/schemas/personal-agent-session";
import { getApiClient } from "./lib/api-client";
import { handlePublicSkillIndex } from "./well-known";

export async function handlePersonalAgentInterfaces(input: {
	request: Request;
	appId: string;
	organizationId: string;
	env: CloudflareEnv;
}): Promise<Response> {
	const { request, appId, organizationId, env } = input;
	const url = new URL(request.url);
	const feedback = url.pathname.endsWith("/feedback");
	const headers = { "Cache-Control": "private, no-store" };
	if (request.method !== (feedback ? "POST" : "GET"))
		return new Response(null, {
			status: 405,
			headers: { ...headers, Allow: feedback ? "POST" : "GET" },
		});
	let report;
	if (feedback) {
		try {
			// Bound streamed bodies too; Content-Length is controlled by the caller.
			const reader = request.body?.getReader();
			if (!reader) throw new Error("Missing body");
			const chunks: Uint8Array[] = [];
			let size = 0;
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					size += value.byteLength;
					if (size > 32 * 1024) throw new Error("Body too large");
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
			report = PersonalAgentFeedbackSchema.parse(
				JSON.parse(new TextDecoder().decode(bytes)),
			);
		} catch {
			return Response.json(
				{ error: "invalid_request" },
				{ status: 400, headers },
			);
		}
	}
	const sessionToken = request.headers.get("Poppy-Session");
	const version = request.headers.get("Poppy-Version");
	const client = getApiClient({
		serviceFetch: env.API_SERVICE,
		orgId: organizationId,
	});
	const result = await client.osTenant.personalAgentInterfaces({
		organizationId,
		appId,
		url: request.url,
		method: request.method,
		sessionToken:
			sessionToken && sessionToken.length <= 16384 ? sessionToken : null,
		version: version && version.length <= 32 ? version : null,
		...(report ? { report } : {}),
	});
	if (result.status !== "accepted") {
		const status =
			result.status === "not_configured"
				? 404
				: result.status === "rate_limited"
					? 429
					: result.status === "unavailable"
						? 503
						: 400;
		return Response.json(
			{ error: result.status },
			{
				status,
				headers: {
					...headers,
					...(status === 429 ? { "Retry-After": "60" } : {}),
				},
			},
		);
	}
	if (feedback) return new Response(null, { status: 202, headers });
	const index = await handlePublicSkillIndex(url.hostname, env);
	if (!index.ok) return index;
	return Response.json(
		{
			excluded_tasks: result.excludedTasks ?? [],
			skill_index: await index.json(),
			...(result.feedbackEndpoint
				? { feedback: { endpoint: result.feedbackEndpoint } }
				: {}),
		},
		{ headers },
	);
}
