import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";

export const prerender = false;

// authz: public — deploy provenance only. GIT_SHA is stamped at deploy time
// (--var GIT_SHA:<sha>) so the deployed revision can be compared with main.
export const GET: APIRoute = () =>
	Response.json({
		status: "ok",
		deployedSha: String(env.GIT_SHA || "unknown"),
	});
