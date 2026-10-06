/**
 * Tool Test Stats API Proxy
 */
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { getCatalogClient } from "../../../lib/api";

export const GET: APIRoute = async () => {
	if (!env.API_SERVICE && !env.API_URL) {
		return new Response(JSON.stringify({ error: "API not configured" }), {
			status: 500,
			headers: { "Content-Type": "application/json" },
		});
	}

	try {
		const client = getCatalogClient(env);
		const result = await client.catalog.getToolTestStats({});
		return new Response(JSON.stringify(result), {
			status: 200,
			headers: {
				"Content-Type": "application/json",
				"Cache-Control": "public, max-age=300",
			},
		});
	} catch (error) {
		console.error("[Tool Test Stats Proxy] Error:", error);
		return new Response(
			JSON.stringify({ error: "Failed to fetch tool test stats" }),
			{
				status: 500,
				headers: { "Content-Type": "application/json" },
			},
		);
	}
};
