import { isRecord } from "@tedix/api-contract/utils/is-record";
import { guardedFetch, validateUrl } from "@tedix/ssrf-guard";
import {
	authorizeInteractionEvent,
	type InteractionEventCredential,
} from "./interaction-event-auth";

export const INTERACTION_REPLY_EVENT = "work.interaction.responded";
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const MAX_SUBSCRIPTIONS = 20;
const MAX_PENDING = 100;
const MAX_DELIVERY_ATTEMPTS = 6;
const KEY_ROTATION_OVERLAP_MS = 5 * 60 * 1000;

export const interactionReplyEventDefinition = {
	name: INTERACTION_REPLY_EVENT,
	description:
		"A response was saved to one exact Tedix Interaction. Read the current request and response before continuing; this event grants no execution authority.",
	delivery: ["webhook"],
	inputSchema: {
		type: "object",
		properties: {
			organization_id: { type: "string", format: "uuid" },
			request_id: { type: "string", format: "uuid" },
		},
		required: ["organization_id", "request_id"],
		additionalProperties: false,
	},
	payloadSchema: {
		type: "object",
		properties: {
			organization_id: { type: "string", format: "uuid" },
			request_id: { type: "string", format: "uuid" },
			response_id: { type: "string", format: "uuid" },
		},
		required: ["organization_id", "request_id", "response_id"],
		additionalProperties: false,
	},
};

export class InteractionEventError extends Error {
	constructor(
		readonly code: number,
		message: string,
		readonly data?: Record<string, unknown>,
	) {
		super(message);
	}
}

export function interactionEventTarget(value: unknown): {
	organizationId: string;
	requestId: string;
} {
	if (
		!isRecord(value) ||
		Object.keys(value).some(
			(k) => !["organization_id", "request_id"].includes(k),
		) ||
		typeof value.organization_id !== "string" ||
		!UUID.test(value.organization_id) ||
		typeof value.request_id !== "string" ||
		!UUID.test(value.request_id)
	)
		throw new InteractionEventError(
			-32602,
			"Choose an exact organization and Interaction UUID",
		);
	return {
		organizationId: value.organization_id.toLowerCase(),
		requestId: value.request_id.toLowerCase(),
	};
}

export function interactionEventShard(
	organizationId: string,
	requestId: string,
): string {
	return `events:${organizationId}:${requestId}`;
}

function decodeSecret(secret: unknown): Uint8Array {
	if (
		typeof secret !== "string" ||
		!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)
	)
		throw new InteractionEventError(-32602, "Invalid webhook secret");
	try {
		const bytes = Uint8Array.from(atob(secret.slice(6)), (c) =>
			c.charCodeAt(0),
		);
		if (bytes.length < 24 || bytes.length > 64) throw new Error("length");
		return bytes;
	} catch {
		throw new InteractionEventError(-32602, "Invalid webhook secret");
	}
}

async function digest(value: string): Promise<string> {
	return Array.from(
		new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
		),
		(b) => b.toString(16).padStart(2, "0"),
	).join("");
}

/** Serialize once; sign exactly the bytes sent. Public fetch isolation is also required. */
export async function sendInteractionWebhook(
	url: string,
	secret: string,
	subscriptionId: string,
	eventId: string,
	payload: unknown,
	previousSecret?: string,
): Promise<Response> {
	const body = JSON.stringify(payload);
	if (new TextEncoder().encode(body).length > 256 * 1024)
		throw new Error("Webhook payload exceeds limit");
	const timestamp = Math.floor(Date.now() / 1000).toString();
	const signatures = await Promise.all(
		[...new Set([secret, ...(previousSecret ? [previousSecret] : [])])].map(
			async (signingSecret) => {
				const key = await crypto.subtle.importKey(
					"raw",
					decodeSecret(signingSecret),
					{ name: "HMAC", hash: "SHA-256" },
					false,
					["sign"],
				);
				const mac = new Uint8Array(
					await crypto.subtle.sign(
						"HMAC",
						key,
						new TextEncoder().encode(`${eventId}.${timestamp}.${body}`),
					),
				);
				return `v1,${btoa(String.fromCharCode(...mac))}`;
			},
		),
	);
	return guardedFetch(
		url,
		{
			method: "POST",
			body,
			headers: {
				"Content-Type": "application/json",
				"webhook-id": eventId,
				"webhook-timestamp": timestamp,
				"webhook-signature": signatures.join(" "),
				"X-MCP-Subscription-Id": subscriptionId,
			},
			signal: AbortSignal.timeout(5000),
		},
		{ maxRedirects: 0 },
	);
}

type Subscription = InteractionEventCredential & {
	id: string;
	owner: string;
	url: string;
	secret: string;
	previousSecret?: string;
	previousSecretExpiresAt?: number;
	expiresAt: number;
};
type Pending = {
	subscriptionId: string;
	responseId: string;
	respondedAt: string;
	attempts: number;
	nextAt: number;
	expiresAt: number;
	outcome?: "acknowledged" | "failed";
};
export type InteractionReplyPublication = {
	organizationId: string;
	requestId: string;
	responseId: string;
	respondedAt: string;
};
type Dependencies = {
	authorize: typeof authorizeInteractionEvent;
	send: typeof sendInteractionWebhook;
};

/** Stored in the existing subscription DO, sharded by organization + request.
 * No model polling, transcripts, secondary Work queue or automatic approvals.
 */
export class InteractionEventSubscriptions {
	constructor(
		private storage: DurableObjectStorage,
		private env: CloudflareEnv,
		private dependencies: Dependencies = {
			authorize: authorizeInteractionEvent,
			send: sendInteractionWebhook,
		},
	) {}

	async subscribe(input: {
		credential: InteractionEventCredential;
		params: Record<string, unknown>;
	}): Promise<Record<string, unknown>> {
		const { credential, params } = input;
		if (params.name !== INTERACTION_REPLY_EVENT || params.cursor != null)
			throw new InteractionEventError(
				-32602,
				"Unknown event or unsupported cursor; this event is non-replayable",
			);
		const target = interactionEventTarget(params.arguments);
		if (
			target.organizationId !== credential.organizationId ||
			target.requestId !== credential.requestId
		)
			throw new InteractionEventError(-32602, "Interaction filter mismatch");
		const delivery = params.delivery;
		if (
			!isRecord(delivery) ||
			delivery.mode !== "webhook" ||
			typeof delivery.url !== "string" ||
			delivery.url.length > 2048
		)
			throw new InteractionEventError(
				-32602,
				"HTTPS webhook delivery required",
			);
		let url: URL;
		try {
			url = new URL(delivery.url);
		} catch {
			throw new InteractionEventError(-32602, "Invalid public webhook URL");
		}
		if (url.username || url.password || url.hash || validateUrl(url.toString()))
			throw new InteractionEventError(-32602, "Invalid public webhook URL");
		decodeSecret(delivery.secret);
		const secret = delivery.secret as string;
		if (
			params.ttlMs != null &&
			(typeof params.ttlMs !== "number" ||
				!Number.isSafeInteger(params.ttlMs) ||
				params.ttlMs < 1000)
		)
			throw new InteractionEventError(-32602, "Invalid subscription TTL");
		let authority: Awaited<ReturnType<typeof authorizeInteractionEvent>>;
		try {
			authority = await this.dependencies.authorize(this.env, credential);
		} catch {
			throw new InteractionEventError(
				-32003,
				"Current human OAuth access to this Interaction is required",
			);
		}
		const expiresAt = Math.min(
			authority.expiresAt,
			Date.now() +
				Math.min((params.ttlMs as number | null) ?? DEFAULT_TTL_MS, MAX_TTL_MS),
		);
		if (expiresAt <= Date.now() + 1000)
			throw new InteractionEventError(
				-32003,
				"Credential expires too soon; reconnect",
			);
		const id = await subscriptionId(
			credential,
			authority.owner,
			url.toString(),
		);
		const previous = await this.storage.get<Subscription>(`sub:${id}`);
		const subscriptions = await this.storage.list<Subscription>({
			prefix: "sub:",
			limit: MAX_SUBSCRIPTIONS + 1,
		});
		for (const [key, sub] of subscriptions)
			if (sub.expiresAt <= Date.now()) await this.storage.delete(key);
		if (
			!previous &&
			[...subscriptions.values()].filter((s) => s.expiresAt > Date.now())
				.length >= MAX_SUBSCRIPTIONS
		)
			throw new InteractionEventError(
				-32000,
				"Interaction subscription limit reached",
			);
		// Idempotent renewal does not produce another callback challenge unless
		// the callback/secret changed or the previous lease expired.
		if (
			!previous ||
			previous.secret !== secret ||
			previous.expiresAt <= Date.now()
		) {
			const challenge = crypto.randomUUID();
			try {
				const response = await this.dependencies.send(
					url.toString(),
					secret,
					id,
					`verify_${crypto.randomUUID()}`,
					{ type: "verification", challenge },
					previous && previous.expiresAt > Date.now()
						? previous.secret
						: undefined,
				);
				const reply = response.ok
					? await boundedChallengeReply(response)
					: null;
				if (
					!isRecord(reply) ||
					typeof reply.challenge !== "string" ||
					!constantTimeEqual(reply.challenge, challenge)
				)
					throw new Error("challenge");
			} catch {
				throw new InteractionEventError(
					-32015,
					"Callback verification failed",
					{ reason: "challenge_failed" },
				);
			}
		}
		await this.storage.transaction(async (transaction) => {
			const current = await transaction.list<Subscription>({
				prefix: "sub:",
				limit: MAX_SUBSCRIPTIONS + 1,
			});
			for (const [key, sub] of current)
				if (sub.expiresAt <= Date.now()) {
					await transaction.delete(key);
					current.delete(key);
				}
			if (!current.has(`sub:${id}`) && current.size >= MAX_SUBSCRIPTIONS)
				throw new InteractionEventError(
					-32000,
					"Interaction subscription limit reached",
				);
			await transaction.put(`sub:${id}`, {
				...credential,
				id,
				owner: authority.owner,
				url: url.toString(),
				secret,
				...(previous &&
				previous.secret !== secret &&
				previous.expiresAt > Date.now()
					? {
							previousSecret: previous.secret,
							previousSecretExpiresAt: Math.min(
								previous.expiresAt,
								Date.now() + KEY_ROTATION_OVERLAP_MS,
							),
						}
					: previous?.previousSecret &&
						  (previous.previousSecretExpiresAt ?? 0) > Date.now()
						? {
								previousSecret: previous.previousSecret,
								previousSecretExpiresAt: previous.previousSecretExpiresAt,
							}
						: {}),
				expiresAt,
			} satisfies Subscription);
			const saved = await transaction.get<Subscription>(`sub:${id}`);
			await this.schedule(
				Math.min(expiresAt, saved?.previousSecretExpiresAt ?? Infinity),
				transaction,
			);
		});
		return {
			id,
			refreshBefore: new Date(expiresAt).toISOString(),
			cursor: null,
			truncated: false,
		};
	}

	async unsubscribe(input: {
		credential: InteractionEventCredential;
		params: Record<string, unknown>;
	}): Promise<Record<string, unknown>> {
		const target = interactionEventTarget(input.params.arguments);
		if (
			input.params.name !== INTERACTION_REPLY_EVENT ||
			target.organizationId !== input.credential.organizationId ||
			target.requestId !== input.credential.requestId
		)
			throw new InteractionEventError(-32602, "Interaction filter mismatch");
		const delivery = input.params.delivery;
		if (
			!isRecord(delivery) ||
			delivery.mode !== "webhook" ||
			typeof delivery.url !== "string" ||
			delivery.url.length > 2048
		)
			throw new InteractionEventError(
				-32602,
				"HTTPS webhook delivery required",
			);
		let url: URL;
		try {
			url = new URL(delivery.url);
		} catch {
			throw new InteractionEventError(-32602, "Invalid public webhook URL");
		}
		if (url.username || url.password || url.hash || validateUrl(url.toString()))
			throw new InteractionEventError(-32602, "Invalid public webhook URL");
		let authority: Awaited<ReturnType<typeof authorizeInteractionEvent>>;
		try {
			authority = await this.dependencies.authorize(this.env, input.credential);
		} catch {
			throw new InteractionEventError(
				-32003,
				"Current human OAuth access required",
			);
		}
		const id = await subscriptionId(
			input.credential,
			authority.owner,
			url.toString(),
		);
		const sub = await this.storage.get<Subscription>(`sub:${id}`);
		if (
			sub &&
			(sub.owner !== authority.owner ||
				sub.mcpUrl !== input.credential.mcpUrl ||
				sub.organizationId !== input.credential.organizationId ||
				sub.requestId !== input.credential.requestId)
		)
			throw new InteractionEventError(
				-32003,
				"Subscription belongs to another caller or resource",
			);
		await this.storage.delete(`sub:${id}`);
		return {};
	}

	async publish(event: InteractionReplyPublication): Promise<number> {
		if (
			![event.organizationId, event.requestId, event.responseId].every((id) =>
				UUID.test(id),
			) ||
			!Number.isFinite(Date.parse(event.respondedAt))
		)
			throw new InteractionEventError(-32602, "Invalid saved response receipt");
		const accepted = await this.storage.transaction(async (transaction) => {
			const subscriptions = await transaction.list<Subscription>({
				prefix: "sub:",
				limit: MAX_SUBSCRIPTIONS + 1,
			});
			const pending = await transaction.list<Pending>({
				prefix: "reply:",
				limit: MAX_PENDING + 1,
			});
			const additions = [...subscriptions.values()].filter(
				(sub) =>
					sub.expiresAt > Date.now() &&
					sub.organizationId === event.organizationId &&
					sub.requestId === event.requestId &&
					!pending.has(`reply:${sub.id}:${event.responseId}`),
			);
			if (pending.size + additions.length > MAX_PENDING)
				throw new InteractionEventError(-32000, "Delivery capacity reached");
			for (const sub of additions)
				await transaction.put(`reply:${sub.id}:${event.responseId}`, {
					subscriptionId: sub.id,
					responseId: event.responseId,
					respondedAt: event.respondedAt,
					attempts: 0,
					nextAt: Date.now(),
					expiresAt: sub.expiresAt,
				} satisfies Pending);
			if (additions.length) await this.schedule(Date.now(), transaction);
			return additions.length;
		});
		return accepted;
	}

	async alarm(): Promise<void> {
		const now = Date.now();
		const subscriptions = await this.storage.list<Subscription>({
			prefix: "sub:",
			limit: MAX_SUBSCRIPTIONS + 1,
		});
		for (const [key, sub] of subscriptions) {
			if (sub.expiresAt <= now) await this.storage.delete(key);
			else if (
				sub.previousSecret &&
				(sub.previousSecretExpiresAt ?? 0) <= now
			) {
				delete sub.previousSecret;
				delete sub.previousSecretExpiresAt;
				await this.storage.put(key, sub);
			}
		}
		const pending = await this.storage.list<Pending>({
			prefix: "reply:",
			limit: MAX_PENDING + 1,
		});
		for (const [key, reply] of pending) {
			const sub = subscriptions.get(`sub:${reply.subscriptionId}`);
			if (!sub || sub.expiresAt <= now || reply.expiresAt <= now) {
				await this.storage.delete(key);
				continue;
			}
			if (reply.outcome) continue;
			if (reply.nextAt > now) continue;
			try {
				const current = await this.dependencies.authorize(this.env, sub);
				if (current.owner !== sub.owner || current.expiresAt <= Date.now())
					throw new Error("revoked");
			} catch {
				// Fail closed; unknown access is not permission to disclose an event.
				reply.attempts++;
				if (reply.attempts >= MAX_DELIVERY_ATTEMPTS) {
					reply.outcome = "failed";
					console.warn("[MCP events] reply authorization unavailable", {
						event: "interaction_response.authorization_unavailable",
						attempts: reply.attempts,
					});
				} else
					reply.nextAt =
						Date.now() + Math.min(1000 * 2 ** reply.attempts, 60_000);
				await this.storage.put(key, reply);
				continue;
			}
			let status = 0;
			try {
				const response = await this.dependencies.send(
					sub.url,
					sub.secret,
					sub.id,
					`evt_${reply.responseId}`,
					{
						eventId: `evt_${reply.responseId}`,
						name: INTERACTION_REPLY_EVENT,
						timestamp: reply.respondedAt,
						data: {
							organization_id: sub.organizationId,
							request_id: sub.requestId,
							response_id: reply.responseId,
						},
						cursor: null,
					},
					(sub.previousSecretExpiresAt ?? 0) > Date.now()
						? sub.previousSecret
						: undefined,
				);
				status = response.status;
				await response.body?.cancel();
			} catch {
				/* bounded retry, never log callback URL or credentials */
			}
			reply.attempts++;
			if (
				(status >= 200 && status < 300) ||
				status === 410 ||
				status === 413 ||
				reply.attempts >= MAX_DELIVERY_ATTEMPTS
			) {
				// Retain dedupe receipt until lease expiry. A 2xx is callback ACK,
				// not proof that the originating chat processed or finished work.
				reply.outcome =
					status >= 200 && status < 300 ? "acknowledged" : "failed";
				if (reply.outcome === "failed")
					console.warn("[MCP events] reply callback delivery failed", {
						event: "interaction_response.delivery_failed",
						status,
						attempts: reply.attempts,
					});
			} else {
				reply.nextAt =
					Date.now() + Math.min(1000 * 2 ** reply.attempts, 60_000);
			}
			await this.storage.put(key, reply);
		}
		// A publication can arrive while a callback is in flight. Compute the
		// next alarm from current rows atomically so a fresh delivery is not delayed.
		await this.storage.transaction(async (transaction) => {
			const subs = await transaction.list<Subscription>({
				prefix: "sub:",
				limit: MAX_SUBSCRIPTIONS + 1,
			});
			const replies = await transaction.list<Pending>({
				prefix: "reply:",
				limit: MAX_PENDING + 1,
			});
			const next = Math.min(
				...[...subs.values()].flatMap((s) => [
					s.expiresAt,
					...(s.previousSecretExpiresAt ? [s.previousSecretExpiresAt] : []),
				]),
				...[...replies.values()].map((r) =>
					r.outcome ? r.expiresAt : r.nextAt,
				),
			);
			if (Number.isFinite(next))
				await transaction.setAlarm(Math.max(Date.now() + 1, next));
			else await transaction.deleteAlarm();
		});
	}

	private async schedule(
		at: number,
		storage: Pick<DurableObjectStorage, "getAlarm" | "setAlarm">,
	): Promise<void> {
		const current = await storage.getAlarm();
		if (current === null || current > at)
			await storage.setAlarm(Math.max(Date.now() + 1, at));
	}
}

async function subscriptionId(
	credential: InteractionEventCredential,
	owner: string,
	url: string,
): Promise<string> {
	return `sub_${credential.organizationId}_${credential.requestId}_${await digest(JSON.stringify([owner, credential.mcpUrl, credential.organizationId, credential.requestId, url, INTERACTION_REPLY_EVENT]))}`;
}

async function boundedChallengeReply(response: Response): Promise<unknown> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Missing challenge response");
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			length += chunk.value.length;
			if (length > 4096) throw new Error("Challenge response too large");
			chunks.push(chunk.value);
		}
	} finally {
		await reader.cancel();
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	return JSON.parse(new TextDecoder().decode(bytes));
}

function constantTimeEqual(a: string, b: string): boolean {
	let difference = a.length ^ b.length;
	for (let i = 0; i < b.length; i++)
		difference |= (a.charCodeAt(i) || 0) ^ b.charCodeAt(i);
	return difference === 0;
}
