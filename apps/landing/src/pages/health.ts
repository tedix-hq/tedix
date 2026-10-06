import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";

// authz: public — deploy provenance only. GIT_SHA is stamped by
// deploy:production (--var GIT_SHA:<sha>); scripts/ci/deploy-lag.ts and
// deploy-safe.ts read it to compute what is and is not shipped.
export const GET: APIRoute = () =>
	Response.json({
		status: "ok",
		deployedSha: String(env.GIT_SHA || "unknown"),
	});
