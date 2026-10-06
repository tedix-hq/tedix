const AUTHORIZATION_HEADERS = [
	"authorization",
	"cookie",
	"proxy-authorization",
	"x-api-key",
	"x-service-binding",
] as const;

function isSignedBytePath(pathname: string): boolean {
	const segments = pathname.split("/");
	if (segments[1] === "artifacts") {
		return segments[2] === "s" && Boolean(segments[3]) && Boolean(segments[4]);
	}
	if (segments[1] === "skill-media") {
		return Boolean(segments[2]) && Boolean(segments[3]);
	}
	return false;
}

function notFound(gitSha: string): Response {
	return new Response("Not Found", {
		status: 404,
		headers: {
			"Cache-Control": "no-store",
			"Content-Type": "text/plain; charset=utf-8",
			"X-Content-Type-Options": "nosniff",
			"X-Tedix-Git-Sha": gitSha,
		},
	});
}

function health(gitSha: string): Response {
	return Response.json(
		{
			deployedSha: gitSha,
			service: "artifact-gateway",
			status: "ok",
		},
		{
			headers: {
				"Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff",
				"X-Tedix-Git-Sha": gitSha,
			},
		},
	);
}

function requestWithoutAuthority(request: Request): Request {
	const headers = new Headers(request.headers);
	for (const name of AUTHORIZATION_HEADERS) headers.delete(name);
	for (const name of [...headers.keys()]) {
		if (name.startsWith("x-tedix-")) headers.delete(name);
	}
	return new Request(request, { headers });
}

function responseWithoutAmbientAuthority(
	response: Response,
	gitSha: string,
): Response {
	const headers = new Headers(response.headers);
	headers.delete("Access-Control-Allow-Credentials");
	headers.delete("Set-Cookie");
	headers.set("Cross-Origin-Resource-Policy", "cross-origin");
	headers.set("Referrer-Policy", "no-referrer");
	headers.set("X-Content-Type-Options", "nosniff");
	headers.set("X-Tedix-Git-Sha", gitSha);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

export async function handleArtifactGatewayRequest(
	request: Request,
	env: Pick<Cloudflare.Env, "API_SERVICE" | "GIT_SHA">,
): Promise<Response> {
	const url = new URL(request.url);
	// authz: public — liveness + deployed-sha probe; serves no tenant data.
	if (request.method === "GET" && url.pathname === "/health")
		return health(env.GIT_SHA);
	if (request.method !== "GET" && request.method !== "HEAD")
		return notFound(env.GIT_SHA);
	if (!isSignedBytePath(url.pathname)) return notFound(env.GIT_SHA);

	const response = await env.API_SERVICE.fetch(
		requestWithoutAuthority(request),
	);
	return responseWithoutAmbientAuthority(response, env.GIT_SHA);
}

export default {
	fetch(request, env) {
		return handleArtifactGatewayRequest(request, env);
	},
} satisfies ExportedHandler<Cloudflare.Env>;
