/**
 * Outbound Email
 *
 * Cloudflare Email Service is the canonical outbound transport. The `EMAIL`
 * binding is configured on apps/api and sends from the onboarded Tedix domain.
 *
 * Public API:
 *   sendTransactionalEmail(env, params)      — sender used by
 *                                                tediEmail.sendEmail.
 */

export interface EmailRecipient {
	email: string;
	name?: string;
}

export interface TransactionalEmailParams {
	from: EmailRecipient;
	to: EmailRecipient[];
	cc?: EmailRecipient[];
	bcc?: EmailRecipient[];
	subject: string;
	text?: string;
	html?: string;
	replyTo?: EmailRecipient;
	headers?: Record<string, string>;
}

export type TransactionalEmailResult =
	| {
			ok: true;
			sent: true;
			messageId?: string;
			provider: "cloudflare";
	  }
	| {
			ok: false;
			sent: false;
			reason: string;
			provider: "cloudflare";
	  };

interface MinimalEmailEnv {
	EMAIL?: SendEmail;
}

export async function sendTransactionalEmail(
	env: MinimalEmailEnv,
	params: TransactionalEmailParams,
): Promise<TransactionalEmailResult> {
	if (!env.EMAIL) {
		return {
			ok: false,
			sent: false,
			reason: "EMAIL binding unavailable",
			provider: "cloudflare",
		};
	}
	return sendViaCloudflare(env.EMAIL, params);
}

async function sendViaCloudflare(
	emailBinding: SendEmail,
	params: TransactionalEmailParams,
): Promise<TransactionalEmailResult> {
	const text = params.text ?? stripHtml(params.html ?? "");
	try {
		const result = await emailBinding.send({
			from: toCloudflareAddress(params.from),
			to: params.to.map(toCloudflareAddress),
			subject: params.subject,
			text,
			...(params.cc?.length ? { cc: params.cc.map(toCloudflareAddress) } : {}),
			...(params.bcc?.length
				? { bcc: params.bcc.map(toCloudflareAddress) }
				: {}),
			...(params.html ? { html: params.html } : {}),
			...(params.replyTo
				? { replyTo: toCloudflareAddress(params.replyTo) }
				: {}),
			...(params.headers && Object.keys(params.headers).length > 0
				? { headers: params.headers }
				: {}),
		});
		return {
			ok: true,
			sent: true,
			messageId: result.messageId,
			provider: "cloudflare",
		};
	} catch (err) {
		console.error(
			`[email] Cloudflare Email Service send failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return {
			ok: false,
			sent: false,
			reason:
				err instanceof Error
					? err.message
					: "Cloudflare Email Service send failed",
			provider: "cloudflare",
		};
	}
}

function toCloudflareAddress(recipient: EmailRecipient): string | EmailAddress {
	const name = recipient.name?.trim();
	return name ? { email: recipient.email, name } : recipient.email;
}

function stripHtml(html: string): string {
	return html
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<[^>]+>/g, "")
		.replace(/\s+/g, " ")
		.trim();
}
