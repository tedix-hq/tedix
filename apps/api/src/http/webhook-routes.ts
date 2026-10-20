import type { Hono } from "hono";

export function registerWebhookRoutes(app: Hono<{ Bindings: CloudflareEnv }>) {
	// =============================================================================
	// WEBHOOK ENDPOINTS
	// =============================================================================

	/**
	 * Webhook handlers below are LAZY, like the kernel/media/artifact
	 * routes above: they only fire on inbound provider callbacks, so their
	 * implementation graphs (audit + billing queries, stripe-billing helpers,
	 * fleet-authority) must not be evaluated on every isolate's first request.
	 */
	// authz: public GitHub OIDC signature, audience, repo, ref, workflow and payload SHA are verified in the lazy handler against tenant D1 configuration.
	app.post("/webhooks/repository-observer/:orgId/:projectId", async (c) => {
		const { handleRepositoryObserverWebhook } =
			await import("../webhooks/repository-observer");
		return handleRepositoryObserverWebhook(c);
	});

	// authz: public Provider callbacks verify per-channel hashed capabilities, provider resource identity and active subscriptions in the lazy handler.
	app.post("/webhooks/provider-events/:adapter/:channelId", async (c) => {
		const { handleProviderEventWebhook } =
			await import("../webhooks/provider-events");
		return handleProviderEventWebhook(
			c,
			c.req.param("adapter"),
			c.req.param("channelId"),
		);
	});

	/**
	 * Descope Audit webhook endpoint
	 * Receives audit events from Descope Webhook Connector and writes to audit_events D1
	 * No auth required - secured via HMAC-SHA256 signature verification (x-descope-webhook-s256)
	 */
	app.post("/webhooks/descope/audit", async (c) => {
		const { handleDescopeAuditWebhook } =
			await import("../webhooks/descope-audit");
		return handleDescopeAuditWebhook(c);
	});

	/**
	 * Stripe webhook endpoint
	 * Processes subscription lifecycle events (checkout, updates, cancellation, payment failures)
	 * No auth required - secured via Stripe signature verification
	 */
	app.post("/webhooks/stripe", async (c) => {
		const { handleStripeWebhook } = await import("../webhooks/stripe");
		return handleStripeWebhook(c, "live");
	});

	app.post("/webhooks/stripe/test", async (c) => {
		const { handleStripeWebhook } = await import("../webhooks/stripe");
		return handleStripeWebhook(c, "test");
	});
}
