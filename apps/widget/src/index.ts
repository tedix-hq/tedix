// Public wildcard: the embed loader is served to any host site and carries no
// credentials, so the worker-kit origin allowlist does not apply here.
const corsHeaders = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
	"Cross-Origin-Resource-Policy": "cross-origin",
} as const;

function withAssetPolicy(request: Request, response: Response): Response {
	const headers = new Headers(response.headers);
	const pathname = new URL(request.url).pathname;
	const contentAddressedBundle =
		/^\/v1\/(?:embed|loader)\.[a-f0-9]{64}\.js$/.test(pathname);
	const mutableAlias = [
		"/embed.js",
		"/loader.js",
		"/v1/embed.js",
		"/v1/loader.js",
		"/v1/manifest.json",
	].includes(pathname);
	for (const [key, value] of Object.entries(corsHeaders))
		headers.set(key, value);
	headers.set("X-Content-Type-Options", "nosniff");
	headers.set(
		"Cache-Control",
		// A content-addressed URL does not make a failed response immutable.
		// Caching a deployment-time miss can strand the loader after recovery.
		response.status >= 400
			? "no-store"
			: contentAddressedBundle
				? "public, max-age=31536000, immutable"
				: mutableAlias
					? "no-cache"
					: "public, max-age=300, s-maxage=300",
	);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

export function createWidgetHandler(
	env: Pick<Cloudflare.Env, "ASSETS" | "GIT_SHA">,
) {
	return async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: corsHeaders });
		}
		// authz: public — liveness + deployed-sha probe; serves no tenant data.
		if (url.pathname === "/health") {
			return Response.json({
				status: "ok",
				deployedSha: String(env.GIT_SHA || "unknown"),
			});
		}
		// authz: public — bare origin returns an empty 404; the widget serves only public static assets.
		if (url.pathname === "/") {
			return new Response(null, {
				status: 404,
				headers: {
					"Cache-Control": "no-store",
					"X-Content-Type-Options": "nosniff",
					"X-Robots-Tag": "noindex, nofollow, noarchive",
				},
			});
		}
		if (request.method !== "GET" && request.method !== "HEAD") {
			return new Response("Method Not Allowed", { status: 405 });
		}
		return withAssetPolicy(request, await env.ASSETS.fetch(request));
	};
}

export default {
	fetch(request: Request, env: Cloudflare.Env): Promise<Response> {
		return createWidgetHandler(env)(request);
	},
};
