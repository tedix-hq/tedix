/**
 * Firecrawl Webhook Handler
 * Receives webhook events from Firecrawl Agent API and wakes Cloudflare Workflows
 *
 * Security: HMAC-SHA256 signature verification (required)
 * Flow: Firecrawl → Webhook → instance.sendEvent() → Workflow resumes
 *
 * Event types:
 * - agent.started: Acknowledged without delivery to the workflow
 * - agent.action: Acknowledged without delivery to the workflow
 * - agent.completed: Job completed successfully with data
 * - agent.failed: Job failed with error
 * - agent.cancelled: Job cancelled by user
 *
 * @see https://docs.firecrawl.dev/webhooks/overview
 * @see https://docs.firecrawl.dev/webhooks/events#agent-events
 * @see https://developers.cloudflare.com/workflows/build/events-and-parameters/
 */

import type { Context } from "hono";

import { z } from "zod";
import { timingSafeEqual } from "@tedix/worker-kit/crypto";
import { safeErrorMetadata } from "../lib/safe-log-metadata";

async function logWebhookException(
	event: string,
	error: unknown,
): Promise<void> {
	try {
		console.error(
			JSON.stringify({ event, exception: await safeErrorMetadata(error) }),
		);
	} catch {
		console.error(
			JSON.stringify({ event, exception: { metadataUnavailable: true } }),
		);
	}
}

// Provider UUIDs form the bounded suffix of Cloudflare's event type (max 100 chars).
const TerminalEventSchema = z
	.object({
		type: z.enum(["agent.completed", "agent.failed", "agent.cancelled"]),
		success: z.boolean(),
		id: z.uuid().transform((id) => id.toLowerCase()),
		metadata: z.object({
			workflowInstanceId: z
				.string()
				.min(1)
				.max(100)
				.regex(/^[a-zA-Z0-9_-]+$/),
			appId: z.uuid(),
		}),
		data: z.array(
			z.object({
				creditsUsed: z.number().finite().nonnegative().optional(),
				data: z.unknown().optional(),
			}),
		),
		error: z.string().optional(),
	})
	.refine((event) => event.success === (event.type === "agent.completed"));

// =============================================================================
// WEBHOOK HANDLER
// =============================================================================

/**
 * Handle incoming Firecrawl webhook events
 *
 * Security:
 * 1. Verify HMAC-SHA256 signature from X-Firecrawl-Signature header
 * 2. Reject requests with invalid/missing signatures
 *
 * Processing:
 * 1. Wake the workflow on completion/failure/cancellation via instance.sendEvent()
 * 2. Acknowledge other events without workflow access
 */
export async function handleFirecrawlWebhook(
	c: Context<{ Bindings: CloudflareEnv }>,
): Promise<Response> {
	try {
		// Step 1: Verify HMAC signature
		const signature = c.req.header("X-Firecrawl-Signature");
		const rawBody = await c.req.text();

		if (!c.env.FIRECRAWL_WEBHOOK_SECRET) {
			console.error(
				"[Firecrawl Webhook] FIRECRAWL_WEBHOOK_SECRET not configured",
			);
			return new Response("Internal Server Error", { status: 500 });
		}

		const isValidSignature = await verifyFirecrawlSignature(
			signature,
			rawBody,
			c.env.FIRECRAWL_WEBHOOK_SECRET,
		);

		if (!isValidSignature) {
			console.error("[Firecrawl Webhook] Invalid signature");
			return new Response("Unauthorized", { status: 401 });
		}

		// Authenticate before interpreting any provider-controlled fields.
		let input: unknown;
		try {
			input = JSON.parse(rawBody);
		} catch {
			return new Response("Invalid webhook payload", { status: 400 });
		}
		const envelope = z.object({ type: z.string().min(1) }).safeParse(input);
		if (!envelope.success)
			return new Response("Invalid webhook payload", { status: 400 });
		if (
			!["agent.completed", "agent.failed", "agent.cancelled"].includes(
				envelope.data.type,
			)
		) {
			// Progress and future event types need no terminal metadata or extracted data.
			return new Response("OK", { status: 200 });
		}
		const parsed = TerminalEventSchema.safeParse(input);
		if (!parsed.success)
			return new Response("Invalid webhook payload", { status: 400 });
		const event = parsed.data;
		const status =
			event.type === "agent.completed"
				? "completed"
				: event.type === "agent.cancelled"
					? "cancelled"
					: "failed";
		const instance = await c.env.EXTRACTION_WORKFLOW.get(
			event.metadata.workflowInstanceId,
		);
		await instance.sendEvent({
			type: `firecrawl-agent-${event.id}`,
			payload: {
				success: event.success,
				status,
				data: event.data[0]?.data,
				creditsUsed: event.data[0]?.creditsUsed,
				error:
					status === "completed"
						? undefined
						: event.error?.trim().slice(0, 500) || `Firecrawl agent ${status}`,
				firecrawlJobId: event.id,
			},
		});

		return new Response("OK", { status: 200 });
	} catch (error) {
		await logWebhookException("firecrawl.webhook.processing_failed", error);
		return new Response(
			JSON.stringify({
				error: "Internal webhook processing error",
			}),
			{ status: 500, headers: { "Content-Type": "application/json" } },
		);
	}
}

// =============================================================================
// SIGNATURE VERIFICATION
// =============================================================================

/**
 * Verify Firecrawl HMAC-SHA256 signature
 *
 * Firecrawl signs every webhook with HMAC-SHA256 using your webhook secret.
 * Header format: X-Firecrawl-Signature: sha256=<hex_hash>
 *
 * @see https://docs.firecrawl.dev/webhooks/security
 */
async function verifyFirecrawlSignature(
	signature: string | undefined,
	body: string,
	secret: string,
): Promise<boolean> {
	if (!signature) {
		console.error("[Webhook] Missing X-Firecrawl-Signature header");
		return false;
	}

	const parts = signature.split("=");
	if (parts.length !== 2) {
		console.error("[Webhook] Invalid signature format (expected: sha256=hash)");
		return false;
	}

	const [algorithm, hash] = parts;

	if (algorithm !== "sha256") {
		console.error("[Webhook] Invalid signature algorithm");
		return false;
	}

	if (!hash || hash.length === 0) {
		console.error("[Webhook] Missing hash in signature");
		return false;
	}

	// Compute expected signature using HMAC-SHA256
	const encoder = new TextEncoder();
	const keyData = encoder.encode(secret);
	const messageData = encoder.encode(body);

	// Web Crypto API (Cloudflare Workers compatible)
	return crypto.subtle
		.importKey("raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, [
			"sign",
		])
		.then((key) => crypto.subtle.sign("HMAC", key, messageData))
		.then((signature) => {
			const expectedHash = Array.from(new Uint8Array(signature))
				.map((b) => b.toString(16).padStart(2, "0"))
				.join("");

			// Timing-safe comparison
			return timingSafeEqual(hash, expectedHash);
		})
		.catch(async (error) => {
			await logWebhookException("firecrawl.webhook.signature_failed", error);
			return false;
		});
}
