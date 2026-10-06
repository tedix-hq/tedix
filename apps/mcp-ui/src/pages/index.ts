import type { APIRoute } from "astro";

export const prerender = false;

const headers = {
	"Cache-Control": "no-store",
	"X-Robots-Tag": "noindex, nofollow, noarchive",
};

// authz: public — intentionally empty. This origin is runtime infrastructure,
// not a human-facing route directory or product surface.
export const GET: APIRoute = () => new Response(null, { status: 404, headers });

export const HEAD: APIRoute = GET;
