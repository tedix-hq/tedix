import { getApiClient } from "./lib/api-client";

/** Session identity never becomes x-tedix-auth-* headers or an OAuth principal. */
export async function checkSignedOutPersonalAgentSession(input: {
	request: Request;
	appId: string;
	organizationId: string;
	env: CloudflareEnv;
}): Promise<Response | null> {
	const { request, env, appId, organizationId } = input;
	const client = getApiClient({
		serviceFetch: env.API_SERVICE,
		orgId: organizationId,
	});
	const sessionToken = request.headers.get("Poppy-Session");
	const version = request.headers.get("Poppy-Version");
	const result = await client.osTenant.personalAgentSession({
		organizationId,
		appId,
		url: request.url,
		method: request.method,
		// Oversized credentials fail the protocol check, not RPC input validation.
		sessionToken:
			sessionToken && sessionToken.length > 16384 ? null : sessionToken,
		version: version && version.length > 32 ? null : version,
	});
	if (result.status === "not_configured" || result.status === "accepted")
		return null;
	return Response.json(
		{ error: result.status },
		{
			status: result.status === "rate_limited" ? 429 : 400,
			headers: {
				"Cache-Control": "no-store",
				...(result.status === "rate_limited" ? { "Retry-After": "60" } : {}),
			},
		},
	);
}
