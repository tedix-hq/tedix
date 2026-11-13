import {
	GithubWebhookResourceKeySchema as repository,
	GithubWebhookSubscriptionSchema,
} from "@tedix/api-contract/schemas/provider-events";
import { z } from "zod";
import type { BaseContext } from "../../rpc/orpc";
import type { ProviderEventChannelRow } from "@tedix/db/schema/provider-events";
import { decryptSecret } from "@tedix/db/utils/secrets-encryption";
import { ingestProviderEvent } from "./mcp-events";
import {
	callbackTokenHash,
	constantEqual,
	requireProviderResponse,
	type ProviderAdapter,
	type ProviderFetch,
	type Subscription,
} from "./types";

const events = GithubWebhookSubscriptionSchema.shape.events;
const hook = z.object({
	id: z.number().int().positive(),
	active: z.literal(true),
});
const payloadSchema = z.object({
	repository: z.object({ full_name: z.string() }),
});
const API = "https://api.github.com/repos/";
const headers = (token: string) => ({
	Authorization: `Bearer ${token}`,
	Accept: "application/vnd.github+json",
	"Content-Type": "application/json",
	"User-Agent": "Tedix",
});

/** Repository webhook registration; the 30-day expiry is Tedix's secret rotation window. */
export function githubWebhookAdapter(
	request: ProviderFetch = fetch,
): ProviderAdapter {
	return {
		async validateResource(token, row) {
			repository.parse(row.resourceKey);
			events.parse(row.eventArguments?.events);
			if (row.connectionScope !== "tenant" || row.deliveryMode !== "push")
				throw new Error("GitHub webhooks require organization push delivery");
			const response = await requireProviderResponse(
				await request(`${API}${row.resourceKey}`, {
					headers: headers(token),
					signal: AbortSignal.timeout(15_000),
				}),
			);
			const selected = z
				.object({ full_name: z.string() })
				.parse(await response.json());
			if (selected.full_name.toLowerCase() !== row.resourceKey.toLowerCase())
				throw new Error("Selected repository unavailable");
		},
		async register(token, row, _channelId, secret, callback) {
			const key = repository.parse(row.resourceKey);
			const response = await requireProviderResponse(
				await request(`${API}${key}/hooks`, {
					method: "POST",
					headers: headers(token),
					signal: AbortSignal.timeout(15_000),
					body: JSON.stringify({
						name: "web",
						active: true,
						events: events.parse(row.eventArguments?.events),
						config: {
							url: callback,
							content_type: "json",
							insecure_ssl: "0",
							secret,
						},
					}),
				}),
			);
			const registered = hook.parse(await response.json());
			return {
				providerChannelId: String(registered.id),
				resourceId: key,
				expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString(),
			};
		},
		async stop(token, id, resourceId) {
			const key = repository.parse(resourceId);
			if (!/^\d+$/.test(id)) throw new Error("Invalid webhook id");
			const response = await request(`${API}${key}/hooks/${id}`, {
				method: "DELETE",
				headers: headers(token),
				signal: AbortSignal.timeout(15_000),
			});
			if (response.status !== 404) await requireProviderResponse(response);
		},
	};
}

/** GitHub signs the raw UTF-8 body with HMAC-SHA256, not its delivery headers. */
export async function verifyWebhookSignature(
	secret: string,
	body: string,
	signature: string,
) {
	if (!/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"],
	);
	const bytes = Uint8Array.from(signature.slice(7).match(/../g)!, (hex) =>
		Number.parseInt(hex, 16),
	);
	return crypto.subtle.verify(
		"HMAC",
		key,
		bytes,
		new TextEncoder().encode(body),
	);
}

export async function receiveGithubWebhook(
	context: BaseContext,
	row: Subscription,
	channel: ProviderEventChannelRow,
	request: { headers: Headers; body: string },
): Promise<{ status: number; received?: boolean }> {
	if (channel.status === "stopped" || !channel.signingSecretCiphertext)
		return { status: 404 };
	const secret = await decryptSecret(
		context.env.SECRETS_MASTER_KEY,
		row.organizationId,
		channel.signingSecretCiphertext,
	);
	if (
		!constantEqual(await callbackTokenHash(secret), channel.tokenHash) ||
		!(await verifyWebhookSignature(
			secret,
			request.body,
			request.headers.get("X-Hub-Signature-256") ?? "",
		))
	)
		return { status: 403 };
	let payload: unknown;
	try {
		payload = JSON.parse(request.body);
	} catch {
		return { status: 400 };
	}
	const parsed = payloadSchema.safeParse(payload);
	if (
		!parsed.success ||
		parsed.data.repository.full_name.toLowerCase() !==
			row.resourceKey.toLowerCase()
	)
		return { status: 403 };
	const event = request.headers.get("X-GitHub-Event") ?? "";
	if (event === "ping") return { status: 204 };
	if (
		channel.status !== "active" ||
		!events.parse(row.eventArguments?.events).includes(event)
	)
		return { status: 403 };
	// Delivery headers are unsigned; hash the signed body so changing an id cannot replay a wake.
	await ingestProviderEvent(context, row, {
		eventId: await callbackTokenHash(request.body),
		name: row.resourceKey,
		data: { event, payload },
	});
	return { status: 202, received: true };
}
