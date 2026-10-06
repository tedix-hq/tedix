/**
 * /indexnow-key.txt — IndexNow key verification file
 *
 * IndexNow requires a key file hosted on the domain to prove ownership.
 * This route serves the per-app IndexNow key from app metadata (seoConfig.indexNowKey).
 * The publishPost handler references this URL via the `keyLocation` field when
 * pinging the IndexNow API.
 *
 * @see https://www.indexnow.org/documentation
 */
import type { APIRoute } from "astro";

export const GET: APIRoute = () => {
	return new Response("Not found", { status: 404 });
};
