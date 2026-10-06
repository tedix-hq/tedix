/**
 * Ops-alert egress — shared, multi-channel delivery for the operational digests
 * (platform-health + cost-anomaly). Two INDEPENDENT channels so a broken email
 * path can't silently take down the weekly dead-man's-switch heartbeat with it:
 *
 *   1. Transactional email via the Cloudflare EMAIL binding (the primary lane).
 *   2. An env-gated webhook (fetch POST) — the backstop second channel.
 *
 * Each channel is independently gated (empty recipient/URL = no-op) and fully
 * fail-soft: a channel error is logged and never thrown, so a digest cron can
 * call this without its own try/catch caring about delivery. DRYs the
 * recipient-split + send logic the two digests previously duplicated inline.
 */

import { sendTransactionalEmail } from "./email";

export interface SendOpsAlertOptions {
	subject: string;
	text: string;
	/** Comma-separated recipients (the *_ALERT_EMAIL var value); empty = skip email. */
	emailRecipients?: string;
	/** Independent webhook backstop (HEALTH_ALERT_WEBHOOK); empty/undefined = skip. */
	webhookUrl?: string;
	/** Sender display name; defaults to "Tedix Platform Health". */
	fromName?: string;
	/** Structured fields folded into the webhook JSON payload. */
	meta?: Record<string, unknown>;
}

export interface SendOpsAlertResult {
	emailed: boolean;
	webhookPosted: boolean;
}

/**
 * Deliver an ops alert across every configured channel. Returns which channels
 * actually fired. Never throws.
 */
export async function sendOpsAlert(
	env: { EMAIL?: SendEmail },
	opts: SendOpsAlertOptions,
): Promise<SendOpsAlertResult> {
	const result: SendOpsAlertResult = { emailed: false, webhookPosted: false };

	// Channel 1 — transactional email (DRYs the recipient split).
	const to = (opts.emailRecipients ?? "")
		.split(",")
		.map((e) => ({ email: e.trim() }))
		.filter((r) => r.email);
	if (to.length > 0) {
		try {
			const res = await sendTransactionalEmail(env, {
				from: {
					email: "noreply@tedix.tech",
					name: opts.fromName ?? "Tedix Platform Health",
				},
				to,
				subject: opts.subject,
				text: opts.text,
			});
			result.emailed = res.sent;
		} catch (err) {
			console.warn("[ops-alert] email channel failed:", err);
		}
	}

	// Channel 2 — independent webhook backstop. Env-gated; empty = no-op.
	const webhook = opts.webhookUrl?.trim();
	if (webhook) {
		try {
			const res = await fetch(webhook, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					subject: opts.subject,
					text: opts.text,
					...(opts.meta ? { meta: opts.meta } : {}),
					sentAt: new Date().toISOString(),
				}),
			});
			result.webhookPosted = res.ok;
			if (!res.ok) {
				console.warn(`[ops-alert] webhook non-2xx: ${res.status}`);
			}
		} catch (err) {
			console.warn("[ops-alert] webhook channel failed:", err);
		}
	}

	return result;
}
