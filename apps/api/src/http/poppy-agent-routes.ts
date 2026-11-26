import type { Context, Hono } from "hono";
import { byIp, rateLimit } from "../middleware/rate-limit";

/**
 * Public Poppy personal-agent identity documents.
 *
 * `GET /poppy-agent/<slug>/client.json` serves the tedi's client metadata
 * document (`client_id`) and `GET /poppy-agent/<slug>/jwks.json` its public
 * JWKS. Both are rendered on demand from the encrypted `POPPY_AGENT_SIGNING_KEY`
 * tedi secret, so the private key never leaves the Worker. A tedi without the
 * secret — or an unknown slug — answers 404, which is also what a disabled
 * identity looks like to a Poppy verifier.
 */

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;

function notFound(): Response {
	return new Response("Not found", { status: 404 });
}

async function serveDocument(
	c: Context<{ Bindings: CloudflareEnv }>,
	document: "client" | "jwks",
): Promise<Response> {
	const slug = c.req.param("slug");
	if (!slug || !SLUG_PATTERN.test(slug)) return notFound();
	const { createDbClient } = await import("@tedix/db/client");
	const { loadPoppyAgentPublicDocument } =
		await import("../services/poppy-agent-identity");
	const doc = await loadPoppyAgentPublicDocument(
		c.env,
		createDbClient(c.env.DB),
		slug,
		document,
	);
	if (!doc) return notFound();
	return Response.json(doc, {
		headers: { "Cache-Control": "public, max-age=60" },
	});
}

export function registerPoppyAgentRoutes(
	app: Hono<{ Bindings: CloudflareEnv }>,
) {
	// authz: public — serves only public key material; the slug names the tedi
	// whose documents are requested, and disabled identities answer 404.
	app.use(
		"/poppy-agent/*",
		rateLimit((env) => env.API_RATE_LIMITER, byIp, { limit: 60 }),
	);
	app.get("/poppy-agent/:slug/client.json", (c) => serveDocument(c, "client"));
	app.get("/poppy-agent/:slug/jwks.json", (c) => serveDocument(c, "jwks"));
}
