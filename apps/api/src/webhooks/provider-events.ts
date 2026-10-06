import type { Context } from "hono";
import { createContext } from "../rpc/orpc";
import {
	resolveProviderEventChannel,
	getProviderEventSubscription,
	updateProviderEventSubscription,
} from "@tedix/db/queries/provider-events";
import {
	callbackTokenHash,
	constantEqual,
} from "../services/provider-events/types";
import { queueReconciliation } from "../services/provider-events/subscriptions";
async function readNotificationBody(request: Request): Promise<string | null> {
	const reader = request.body?.getReader();
	if (!reader) return "";
	const decoder = new TextDecoder();
	let size = 0,
		result = "";
	for (;;) {
		const chunk = await reader.read();
		if (chunk.done) break;
		size += chunk.value.byteLength;
		if (size > 256_000) {
			await reader.cancel();
			return null;
		}
		result += decoder.decode(chunk.value, { stream: true });
	}
	return result + decoder.decode();
}
export async function handleProviderEventWebhook(
	c: Context<{ Bindings: CloudflareEnv }>,
	adapter: string,
	channelId: string,
) {
	const context = createContext(c.req.raw, c.env, (p) =>
		c.executionCtx.waitUntil(p),
	);
	const channel = await resolveProviderEventChannel(context.db, channelId);
	if (
		!channel ||
		channel.status === "stopped" ||
		Date.parse(channel.expiresAt) <= Date.now()
	)
		return c.text("Unknown channel", 404);
	const row = await getProviderEventSubscription(
		context.db,
		channel.organizationId,
		channel.subscriptionId,
	);
	if (!row || row.status === "disabled" || row.adapter !== adapter)
		return c.text("Unknown channel", 404);
	const challenge = c.req.query("validationToken");
	if (adapter === "microsoft_calendar" && challenge !== undefined) {
		if (channel.status !== "pending" || challenge.length > 4096)
			return c.text("Invalid validation", 403);
		return c.text(challenge, 200);
	}
	if (adapter === "google_calendar") {
		const token = c.req.header("X-Goog-Channel-Token") ?? "";
		if (
			c.req.header("X-Goog-Channel-Id") !== channelId ||
			!constantEqual(await callbackTokenHash(token), channel.tokenHash)
		)
			return c.text("Invalid notification", 403);
		const state = c.req.header("X-Goog-Resource-State");
		// Initial sync may precede watch response. It carries no event details.
		if (state === "sync" && channel.status === "pending")
			return c.body(null, 204);
		if (
			channel.status !== "active" ||
			c.req.header("X-Goog-Resource-Id") !== channel.resourceId ||
			!["sync", "exists", "not_exists"].includes(state ?? "")
		)
			return c.text("Invalid notification", 403);
		const number = c.req.header("X-Goog-Message-Number");
		if (!number || !/^\d{1,30}$/.test(number))
			return c.text("Invalid notification", 400);
		await queueReconciliation(context, row, `google:${channelId}:${number}`);
	} else if (adapter === "microsoft_calendar") {
		const contentLength = Number(c.req.header("content-length") ?? 0);
		if (contentLength > 256_000) return c.text("Payload too large", 413);
		const raw = await readNotificationBody(c.req.raw);
		if (raw === null) return c.text("Payload too large", 413);
		let payload: unknown;
		try {
			payload = JSON.parse(raw);
		} catch {
			return c.text("Invalid payload", 400);
		}
		const entries = (payload as { value?: unknown[] })?.value;
		if (!Array.isArray(entries) || entries.length > 100)
			return c.text("Invalid payload", 400);
		// Validate the entire batch before persisting any dispatch.
		const keys: string[] = [];
		for (const entry of entries) {
			if (!entry || typeof entry !== "object")
				return c.text("Invalid notification", 403);
			const item = entry as Record<string, unknown>;
			if (
				channel.status !== "active" ||
				item.subscriptionId !== channel.providerChannelId ||
				typeof item.clientState !== "string" ||
				!constantEqual(
					await callbackTokenHash(item.clientState),
					channel.tokenHash,
				)
			)
				return c.text("Invalid notification", 403);
			if (
				item.lifecycleEvent !== undefined &&
				!["reauthorizationRequired", "subscriptionRemoved", "missed"].includes(
					String(item.lifecycleEvent),
				)
			)
				return c.text("Invalid notification", 403);
			if (
				item.lifecycleEvent === undefined &&
				!["created", "updated", "deleted"].includes(String(item.changeType))
			)
				return c.text("Invalid notification", 403);
			keys.push(
				`graph:${channelId}:${await callbackTokenHash(JSON.stringify(item))}`,
			);
		}
		for (const key of keys) await queueReconciliation(context, row, key);
		if (
			entries.some((item) => (item as Record<string, unknown>).lifecycleEvent)
		)
			await updateProviderEventSubscription(
				context.db,
				row.organizationId,
				row.id,
				{ expiresAt: new Date().toISOString() },
			);
	} else return c.text("Unknown adapter", 404);
	await updateProviderEventSubscription(
		context.db,
		row.organizationId,
		row.id,
		{ lastNotificationAt: new Date().toISOString() },
	);
	// Durable outbox committed before ACK; cron drains and retries independently.
	return c.body(null, 202);
}
