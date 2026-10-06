import type { APIRoute } from "astro";
import { AGENT_CARD_PATH } from "../../lib/agent-card";

export const GET: APIRoute = ({ url }) =>
	new Response(null, {
		status: 308,
		headers: {
			"Cache-Control": "public, max-age=3600",
			Location: new URL(AGENT_CARD_PATH, url).toString(),
		},
	});
