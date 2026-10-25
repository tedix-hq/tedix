import { getInternalApiClient } from "@tedix/api-client/internal";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import {
	authorizeEventCaller,
	type EventCallerCredential,
} from "./interaction-event-auth";
import {
	INTERACTION_REPLY_EVENT,
	InteractionEventError,
	sendInteractionWebhook,
	verifyWebhookCallback,
	webhookDeliveryTarget,
} from "./interaction-events";
import {
	assertEventCursor,
	eventArguments,
	eventReadScopes,
	isPollableEvent,
	type PollableEventName,
	readEventFeed,
} from "./work-events";

/**
 * SEP-3415 webhook delivery for the ledger events (`work.item.state_changed`,
 * `work.approval.requested`, `skill.run.failed`).
 *
 * A subscription is a D1 lease (through the API) holding the feed position and
 * a sealed copy of the subscriber's bearer and callback secret. The API cron
 * asks this Worker to deliver every two minutes. Each pass revalidates the
 * bearer, live consent, organization selection, read scope and the app's
 * `mcpConfig.eventWebhooks` opt-in, reads the organization's own feed after
 * the stored cursor and POSTs each event signed like
 * `work.interaction.responded`. Delivery is at-least-once: the cursor moves
 * only after every event of a page was acknowledged, and `webhook-id` is the
 * stable event id for dedupe. Failures back off; after
 * {@link MAX_CONSECUTIVE_FAILURES} the lease turns unhealthy and stops until
 * the subscriber subscribes again.
 */

export const MAX_CONSECUTIVE_FAILURES = 6;
/** Per-subscription storm guard: events delivered per rolling hour. */
export const MAX_EVENTS_PER_HOUR = 300;
const EVENTS_PER_PASS = 25;
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_TTL_MS = HOUR_MS;
const MAX_TTL_MS = 24 * HOUR_MS;
const BASE_BACKOFF_MS = 2 * 60 * 1000;
const MAX_BACKOFF_MS = 30 * 60 * 1000;
const CLAIM_LIMIT = 25;
const CLAIM_ROUNDS = 4;
const PARALLEL_DELIVERIES = 5;

type ApiClient = ReturnType<typeof getInternalApiClient>;
type EventsApi = Pick<ApiClient["mcpEvents"], keyof ApiClient["mcpEvents"]>;

export type EventWebhookDependencies = {
	authorize: typeof authorizeEventCaller;
	send: typeof sendInteractionWebhook;
	now: () => number;
};

const defaultDependencies: EventWebhookDependencies = {
	authorize: authorizeEventCaller,
	send: sendInteractionWebhook,
	now: () => Date.now(),
};

// ---------------------------------------------------------------------------
// Sealed credential: only this Worker can open what it stored through the API.
// ---------------------------------------------------------------------------

type SealedCredential = { authorization: string; secret: string };

function base64Url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
	return Uint8Array.from(
		atob(value.replaceAll("-", "+").replaceAll("_", "/")),
		(c) => c.charCodeAt(0),
	);
}

async function sealingKey(env: CloudflareEnv): Promise<CryptoKey> {
	const material = (env as { PLATFORM_SERVICE_TOKEN?: string })
		.PLATFORM_SERVICE_TOKEN;
	if (!material || material.length < 16)
		throw new Error("Event webhook sealing key unavailable");
	const base = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(material),
		"HKDF",
		false,
		["deriveKey"],
	);
	return crypto.subtle.deriveKey(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: new TextEncoder().encode("tedix-mcp-event-webhooks"),
			info: new TextEncoder().encode("sealed-credential/v1"),
		},
		base,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

/** Bound to one subscription and organization: a row cannot borrow another's. */
export async function sealCredential(
	env: CloudflareEnv,
	binding: { id: string; organizationId: string },
	credential: SealedCredential,
): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = await crypto.subtle.encrypt(
		{
			name: "AES-GCM",
			iv,
			additionalData: new TextEncoder().encode(
				`${binding.id}:${binding.organizationId}`,
			),
		},
		await sealingKey(env),
		new TextEncoder().encode(JSON.stringify(credential)),
	);
	return `v1.${base64Url(iv)}.${base64Url(new Uint8Array(ciphertext))}`;
}

async function openCredential(
	env: CloudflareEnv,
	binding: { id: string; organizationId: string },
	sealed: string,
): Promise<SealedCredential> {
	const [version, iv, ciphertext] = sealed.split(".");
	if (version !== "v1" || !iv || !ciphertext)
		throw new Error("Unknown sealed credential");
	const plain = await crypto.subtle.decrypt(
		{
			name: "AES-GCM",
			iv: fromBase64Url(iv),
			additionalData: new TextEncoder().encode(
				`${binding.id}:${binding.organizationId}`,
			),
		},
		await sealingKey(env),
		fromBase64Url(ciphertext),
	);
	const parsed: unknown = JSON.parse(new TextDecoder().decode(plain));
	if (
		!isRecord(parsed) ||
		typeof parsed.authorization !== "string" ||
		typeof parsed.secret !== "string"
	)
		throw new Error("Invalid sealed credential");
	return { authorization: parsed.authorization, secret: parsed.secret };
}

async function subscriptionId(parts: unknown[]): Promise<string> {
	const digest = new Uint8Array(
		await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(JSON.stringify(parts)),
		),
	);
	return `evsub_${Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function sortedArguments(args: Record<string, string>): [string, string][] {
	return Object.entries(args).sort(([a], [b]) => a.localeCompare(b));
}

// ---------------------------------------------------------------------------
// events/subscribe and events/unsubscribe
// ---------------------------------------------------------------------------

type LedgerWebhookEventName = Exclude<
	PollableEventName,
	typeof INTERACTION_REPLY_EVENT | "lane.requested"
>;

function eventName(params: Record<string, unknown>): LedgerWebhookEventName {
	if (
		!isPollableEvent(params.name) ||
		params.name === INTERACTION_REPLY_EVENT ||
		params.name === "lane.requested"
	)
		throw new InteractionEventError(-32023, "Unknown event", { kind: "event" });
	return params.name;
}

async function authorizeSubscriber(
	env: CloudflareEnv,
	caller: Omit<EventCallerCredential, "organizationId">,
	name: LedgerWebhookEventName,
	organizationId: string,
	dependencies: EventWebhookDependencies,
	requireWebhooks: boolean,
) {
	let authority: Awaited<ReturnType<typeof authorizeEventCaller>>;
	try {
		authority = await dependencies.authorize(
			env,
			{ ...caller, organizationId },
			eventReadScopes(name),
			{ requireWebhooks },
		);
	} catch {
		throw new InteractionEventError(
			-32024,
			"Current human OAuth access to this organization and event is required",
		);
	}
	if (authority.organizationId !== organizationId)
		throw new InteractionEventError(-32024, "Organization not selected");
	return authority;
}

async function subscriptionIdFor(
	owner: string,
	caller: Omit<EventCallerCredential, "organizationId">,
	name: LedgerWebhookEventName,
	args: Record<string, string>,
	url: string,
): Promise<string> {
	return subscriptionId([
		owner,
		caller.mcpUrl,
		args.organization_id,
		name,
		sortedArguments(args),
		url,
	]);
}

/**
 * Create or renew one webhook lease. Renewal is the same call before
 * `refreshBefore`; it keeps the delivered position of a healthy lease.
 */
export async function subscribeEventWebhook(
	env: CloudflareEnv,
	caller: Omit<EventCallerCredential, "organizationId">,
	params: Record<string, unknown>,
	dependencies: EventWebhookDependencies = defaultDependencies,
): Promise<Record<string, unknown>> {
	const name = eventName(params);
	const args = eventArguments(name, params.arguments);
	const { url, secret } = webhookDeliveryTarget(params.delivery, true);
	const requested = params.cursor ?? null;
	if (requested !== null && typeof requested !== "string")
		throw new InteractionEventError(-32602, "Invalid cursor");
	if (requested !== null) assertEventCursor(name, requested);
	const ttlMs = params.ttlMs ?? DEFAULT_TTL_MS;
	if (typeof ttlMs !== "number" || !Number.isSafeInteger(ttlMs) || ttlMs < 1000)
		throw new InteractionEventError(-32602, "Invalid subscription TTL");
	const authority = await authorizeSubscriber(
		env,
		caller,
		name,
		args.organization_id,
		dependencies,
		true,
	);
	const now = dependencies.now();
	const expiresAt = Math.min(
		authority.expiresAt,
		now + Math.min(ttlMs, MAX_TTL_MS),
	);
	if (expiresAt <= now + 1000)
		throw new InteractionEventError(
			-32003,
			"Credential expires too soon; reconnect",
		);
	const id = await subscriptionIdFor(authority.owner, caller, name, args, url);
	await verifyWebhookCallback(dependencies.send, url, secret, id);
	const events = authority.client.mcpEvents as EventsApi;
	const cursor =
		requested ??
		(await readEventFeed(authority.client, name, args, null, 1)).cursor;
	const sealedCredential = await sealCredential(
		env,
		{ id, organizationId: args.organization_id },
		{ authorization: caller.authorization, secret },
	);
	let stored: { cursor: string; expiresAt: string };
	try {
		stored = await events.upsertWebhookSubscription({
			id,
			eventName: name,
			arguments: args,
			mcpUrl: caller.mcpUrl,
			callbackUrl: url,
			sealedCredential,
			cursor,
			keepCursor: requested === null,
			expiresAt: new Date(expiresAt).toISOString(),
		});
	} catch (error) {
		const code =
			isRecord(error) && typeof error.code === "string" ? error.code : "";
		if (code === "TOO_MANY_REQUESTS")
			throw new InteractionEventError(
				-32000,
				"Event subscription limit reached",
			);
		if (code === "FORBIDDEN" || code === "UNAUTHORIZED")
			throw new InteractionEventError(-32024, "Forbidden");
		throw new InteractionEventError(-32603, "Event subscription unavailable");
	}
	return {
		id,
		refreshBefore: new Date(expiresAt).toISOString(),
		cursor: stored.cursor,
		truncated: false,
	};
}

export async function unsubscribeEventWebhook(
	env: CloudflareEnv,
	caller: Omit<EventCallerCredential, "organizationId">,
	params: Record<string, unknown>,
	dependencies: EventWebhookDependencies = defaultDependencies,
): Promise<Record<string, unknown>> {
	const name = eventName(params);
	const args = eventArguments(name, params.arguments);
	const { url } = webhookDeliveryTarget(params.delivery, false);
	// Unsubscribing never needs the delivery opt-in: turning webhooks off for
	// an app must not strand a subscriber that wants to clean up.
	const authority = await authorizeSubscriber(
		env,
		caller,
		name,
		args.organization_id,
		dependencies,
		false,
	);
	const id = await subscriptionIdFor(authority.owner, caller, name, args, url);
	try {
		await (authority.client.mcpEvents as EventsApi).deleteWebhookSubscription({
			id,
		});
	} catch {
		throw new InteractionEventError(-32603, "Event subscription unavailable");
	}
	return {};
}

// ---------------------------------------------------------------------------
// Delivery pass (driven by the API's two-minute cron over the service binding)
// ---------------------------------------------------------------------------

type ClaimedSubscription = Awaited<
	ReturnType<EventsApi["claimDueWebhookSubscriptions"]>
>["subscriptions"][number];

type DeliveryOutcome =
	| "delivered"
	| "idle"
	| "failed"
	| "unhealthy"
	| "rate_limited"
	| "skipped";

async function deliverSubscription(
	env: CloudflareEnv,
	service: Pick<EventsApi, "recordWebhookDelivery">,
	sub: ClaimedSubscription,
	dependencies: EventWebhookDependencies,
): Promise<DeliveryOutcome> {
	const now = dependencies.now();
	if (Date.parse(sub.expiresAt) <= now) return "skipped";
	const iso = (ms: number) => new Date(ms).toISOString();
	let windowStart = sub.rateWindowStartedAt
		? Date.parse(sub.rateWindowStartedAt)
		: Number.NaN;
	let windowCount = sub.rateWindowCount;
	if (!Number.isFinite(windowStart) || now - windowStart >= HOUR_MS) {
		windowStart = now;
		windowCount = 0;
	}
	const record = async (
		outcome: DeliveryOutcome,
		fields: {
			cursor?: string;
			failures: number;
			nextAttemptAt: number;
			delivered?: boolean;
			lastStatus?: number | null;
		},
	): Promise<DeliveryOutcome> => {
		const { recorded } = await service.recordWebhookDelivery({
			id: sub.id,
			claimToken: sub.claimToken,
			organizationId: sub.organizationId,
			cursor: fields.cursor ?? sub.cursor,
			status: outcome === "unhealthy" ? "unhealthy" : "active",
			consecutiveFailures: fields.failures,
			nextAttemptAt: iso(fields.nextAttemptAt),
			rateWindowStartedAt: iso(windowStart),
			rateWindowCount: windowCount,
			lastDeliveredAt: fields.delivered ? iso(now) : null,
			lastStatus: fields.lastStatus ?? null,
		});
		return recorded ? outcome : "skipped";
	};
	const fail = (status: number | null, permanent = false) => {
		const failures = sub.consecutiveFailures + 1;
		if (permanent || failures >= MAX_CONSECUTIVE_FAILURES) {
			console.warn("[MCP events] webhook subscription unhealthy", {
				event: "mcp_event_webhook.unhealthy",
				eventName: sub.eventName,
				status,
				failures,
			});
			return record("unhealthy", {
				failures,
				nextAttemptAt: now,
				lastStatus: status,
			});
		}
		return record("failed", {
			failures,
			nextAttemptAt:
				now + Math.min(BASE_BACKOFF_MS * 2 ** (failures - 1), MAX_BACKOFF_MS),
			lastStatus: status,
		});
	};

	const remaining = MAX_EVENTS_PER_HOUR - windowCount;
	if (remaining <= 0)
		return record("rate_limited", {
			failures: sub.consecutiveFailures,
			nextAttemptAt: windowStart + HOUR_MS,
		});

	let credential: SealedCredential;
	try {
		credential = await openCredential(env, sub, sub.sealedCredential);
	} catch {
		// Unreadable after a key rotation: only a new subscribe can repair it.
		return fail(null, true);
	}
	if (!isPollableEvent(sub.eventName)) return fail(null, true);
	const name = sub.eventName;
	let client: Awaited<ReturnType<typeof authorizeEventCaller>>["client"];
	try {
		const authority = await dependencies.authorize(
			env,
			{
				authorization: credential.authorization,
				mcpUrl: sub.mcpUrl,
				organizationId: sub.organizationId,
			},
			eventReadScopes(name),
			{ requireWebhooks: true },
		);
		if (
			authority.organizationId !== sub.organizationId ||
			authority.owner !== sub.ownerSubject ||
			authority.expiresAt <= now
		)
			throw new Error("authority changed");
		client = authority.client;
	} catch {
		// Fail closed: unknown access is never permission to disclose an event.
		return fail(null);
	}

	let page: Awaited<ReturnType<typeof readEventFeed>>;
	try {
		page = await readEventFeed(
			client,
			name,
			sub.arguments,
			sub.cursor,
			Math.min(remaining, EVENTS_PER_PASS),
		);
	} catch {
		return fail(null);
	}
	// Defense in depth: the feed is organization-bound, and so is the lease.
	const events = page.events.filter(
		(event) => event.data.organization_id === sub.organizationId,
	);
	let lastStatus: number | null = null;
	for (const event of events) {
		let status = 0;
		try {
			const response = await dependencies.send(
				sub.callbackUrl,
				credential.secret,
				sub.id,
				event.eventId,
				{
					eventId: event.eventId,
					name,
					timestamp: event.timestamp,
					data: event.data,
					cursor: page.cursor,
				},
			);
			status = response.status;
			await response.body?.cancel();
		} catch {
			/* bounded retry; never log the callback URL or credentials */
		}
		lastStatus = status;
		// 410 Gone: the receiver retired this endpoint.
		if (status === 410) return fail(status, true);
		if (status < 200 || status >= 300) return fail(status);
	}
	windowCount += events.length;
	return record(events.length ? "delivered" : "idle", {
		cursor: page.cursor,
		failures: 0,
		nextAttemptAt: now,
		delivered: events.length > 0,
		lastStatus,
	});
}

export type DeliveryPassResult = Record<DeliveryOutcome, number> & {
	claimed: number;
};

/** One bounded delivery pass across every organization's due leases. */
export async function deliverDueEventWebhooks(
	env: CloudflareEnv,
	options: {
		service?: Pick<
			EventsApi,
			"claimDueWebhookSubscriptions" | "recordWebhookDelivery"
		>;
		dependencies?: EventWebhookDependencies;
	} = {},
): Promise<DeliveryPassResult> {
	const service =
		options.service ?? (getInternalApiClient(env).mcpEvents as EventsApi);
	const dependencies = options.dependencies ?? defaultDependencies;
	const result: DeliveryPassResult = {
		claimed: 0,
		delivered: 0,
		idle: 0,
		failed: 0,
		unhealthy: 0,
		rate_limited: 0,
		skipped: 0,
	};
	for (let round = 0; round < CLAIM_ROUNDS; round++) {
		const { subscriptions } = await service.claimDueWebhookSubscriptions({
			limit: CLAIM_LIMIT,
			leaseMs: 110_000,
		});
		result.claimed += subscriptions.length;
		for (let i = 0; i < subscriptions.length; i += PARALLEL_DELIVERIES) {
			const outcomes = await Promise.all(
				subscriptions
					.slice(i, i + PARALLEL_DELIVERIES)
					.map((sub) =>
						deliverSubscription(env, service, sub, dependencies).catch(
							() => "skipped" as const,
						),
					),
			);
			for (const outcome of outcomes) result[outcome]++;
		}
		if (subscriptions.length < CLAIM_LIMIT) break;
	}
	return result;
}
