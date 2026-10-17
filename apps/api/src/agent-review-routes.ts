import { createDbClient } from "@tedix/db/client";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import {
	AGENT_REVIEW_MAX_BYTES,
	fileAgentReview,
	readAgentReviewReceipt,
} from "./services/agent-review";

export const agentReviewRoutes = new Hono<{ Bindings: CloudflareEnv }>();

agentReviewRoutes.use("*", async (c, next) => {
	if (new URL(c.req.url).protocol !== "https:")
		return c.json({ error: "HTTPS required" }, 400);
	// Never trust caller credentials or a service header to bypass anonymous limits.
	const limiter = c.env.AGENT_REVIEW_RATE_LIMITER;
	try {
		if (!limiter) return c.json({ error: "Review intake unavailable" }, 503);
		const allowed = await limiter.limit({
			key: `agent-review:ip:${c.req.header("CF-Connecting-IP") ?? "unknown"}`,
		});
		if (!allowed.success)
			return c.json({ error: "Too many requests" }, 429, {
				"Retry-After": "60",
			});
	} catch {
		return c.json({ error: "Review intake unavailable" }, 503);
	}
	c.header("Cache-Control", "no-store");
	c.header("X-Content-Type-Options", "nosniff");
	await next();
});

agentReviewRoutes.post(
	"/",
	bodyLimit({ maxSize: AGENT_REVIEW_MAX_BYTES }),
	async (c) => {
		if (
			c.req.header("Content-Type")?.split(";")[0]?.trim() !== "application/json"
		) {
			return c.json({ error: "Use application/json" }, 415);
		}
		// A global bucket caps anonymous wake costs across rotating client IPs.
		try {
			if (
				!(
					await c.env.AGENT_REVIEW_RATE_LIMITER.limit({
						key: "agent-review:global",
					})
				).success
			) {
				return c.json({ error: "Intake busy" }, 429, { "Retry-After": "60" });
			}
		} catch {
			return c.json({ error: "Review intake unavailable" }, 503);
		}
		let input: unknown;
		try {
			input = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON" }, 400);
		}
		return c.json(
			await fileAgentReview(createDbClient(c.env.DB), c.env, input),
			201,
		);
	},
);

agentReviewRoutes.get("/:id", async (c) => {
	const id = c.req.param("id");
	if (!/^[a-f0-9-]{36}$/.test(id))
		return c.json({ error: "Receipt not found" }, 404);
	return c.json(
		await readAgentReviewReceipt(createDbClient(c.env.DB), c.env, id),
	);
});

agentReviewRoutes.onError((error, c) => {
	if (error instanceof HTTPException)
		return c.json({ error: error.message }, error.status);
	console.error({ event: "agent_review.unavailable" });
	return c.json(
		{ error: "Review intake unavailable; retry the identical payload" },
		503,
	);
});
