import { createDbClient } from "@tedix/db/client";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
	AGENT_REVIEW_MAX_BYTES,
	fileAgentReview,
	readAgentReviewReceipt,
} from "./services/agent-review";

export const agentReviewRoutes = new Hono<{ Bindings: CloudflareEnv }>();

agentReviewRoutes.use("*", async (c, next) => {
	c.header("Cache-Control", "no-store");
	c.header("X-Content-Type-Options", "nosniff");
	c.header("Referrer-Policy", "no-referrer");
	if (new URL(c.req.url).protocol !== "https:") {
		return c.json({ error: "HTTPS required" }, 400);
	}
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
	await next();
});

agentReviewRoutes.post("/", async (c) => {
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
		const reader = c.req.raw.body?.getReader();
		if (!reader) return c.json({ error: "Invalid JSON" }, 400);
		const chunks: Uint8Array[] = [];
		let size = 0;
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > AGENT_REVIEW_MAX_BYTES) {
					await reader.cancel();
					return c.json({ error: "Review exceeds 32 KiB" }, 413);
				}
				chunks.push(value);
			}
		} finally {
			reader.releaseLock();
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		input = JSON.parse(
			new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
		);
	} catch {
		return c.json({ error: "Invalid JSON" }, 400);
	}
	return c.json(
		await fileAgentReview(createDbClient(c.env.DB), c.env, input),
		201,
	);
});

agentReviewRoutes.get("/:id", async (c) => {
	const id = c.req.param("id");
	if (!/^[a-f0-9-]{36}$/.test(id))
		return c.json({ error: "Receipt not found" }, 404);
	await readAgentReviewReceipt(createDbClient(c.env.DB), c.env, id);
	return c.text("received");
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
