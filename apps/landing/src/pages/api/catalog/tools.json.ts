import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { getCatalogClient } from "../../../lib/api";

export const GET: APIRoute = async ({ url }) => {
	const slug = url.searchParams.get("slug");
	if (!slug) return new Response("App slug required", { status: 400 });
	const app = await getCatalogClient(env).catalog.getBySlug({ slug });
	if (!app) return new Response("App not found", { status: 404 });
	return Response.json(app.tools ?? [], {
		headers: { "Cache-Control": "public, max-age=60" },
	});
};
