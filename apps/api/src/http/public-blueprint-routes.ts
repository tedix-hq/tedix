import type { Hono } from "hono";
import { byIp, rateLimit } from "../middleware/rate-limit";

export function registerPublicBlueprintRoutes(
	app: Hono<{ Bindings: CloudflareEnv }>,
) {
	// authz: public — published gallery blueprint summary only (strict allowlist, no organization, member or secret data), rate-limited per IP.
	app.use(
		"/public/blueprints/*",
		rateLimit((env) => env.API_RATE_LIMITER, byIp, { limit: 60 }),
	);
	// authz: public — catalog-visible published blueprints only; private, draft and missing ids are the same 404.
	app.get("/public/blueprints/:blueprintId", async (c) => {
		const [{ handlePublicBlueprintPage }, { createDbQueryClient }] =
			await Promise.all([
				import("../lib/blueprint-landing"),
				import("@tedix/db/query-client"),
			]);
		return handlePublicBlueprintPage(
			createDbQueryClient(c.env.DB),
			c.req.param("blueprintId"),
		);
	});
}
