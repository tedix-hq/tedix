import type { Hono } from "hono";
import { byIp, rateLimit } from "../middleware/rate-limit";

export function registerPublicIntakeRoutes(
	app: Hono<{ Bindings: CloudflareEnv }>,
) {
	// authz: public — enrollment capability checked by the intake; never owner cookies or execution authority.
	app.use(
		"/public/personal-agent/*",
		rateLimit((env) => env.API_RATE_LIMITER, byIp, { limit: 30 }),
	);
	app.all("/public/personal-agent/*", async (c) => {
		const { personalAgentInboundRoutes } =
			await import("../personal-agent-inbound-routes");
		const url = new URL(c.req.url);
		url.pathname = url.pathname.slice("/public/personal-agent".length);
		return personalAgentInboundRoutes.fetch(
			new Request(url, c.req.raw),
			c.env,
			c.executionCtx,
		);
	});

	// authz: public — bounded anonymous feedback intake; no tenant selection or execution authority.
	app.all("/public/agent-review", async (c) => {
		const { agentReviewRoutes } = await import("../agent-review-routes");
		return agentReviewRoutes.fetch(
			new Request(new URL("/", c.req.url), c.req.raw),
			c.env,
			c.executionCtx,
		);
	});
	// authz: public — opaque receipts expose acceptance only, never report or tenant data.
	app.all("/public/agent-review/*", async (c) => {
		const { agentReviewRoutes } = await import("../agent-review-routes");
		const url = new URL(c.req.url);
		url.pathname = url.pathname.slice("/public/agent-review".length);
		return agentReviewRoutes.fetch(
			new Request(url, c.req.raw),
			c.env,
			c.executionCtx,
		);
	});
}
