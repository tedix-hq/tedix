import { MCP_MODERN_PROTOCOL_VERSION } from "@tedix/mcp-shared/protocol";
import { isServiceBinding } from "@tedix/worker-kit/request-auth";
import {
	subscribeEventWebhook,
	unsubscribeEventWebhook,
} from "./event-webhooks";
import {
	InteractionEventError,
	interactionEventShard,
	interactionEventTarget,
	interactionReplyEventDefinition,
} from "./interaction-events";
import {
	isPollableEvent,
	pollableEventDefinitions,
	pollEvent,
} from "./work-events";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import type { ResolvedApp } from "./resolution";
import {
	jsonRpcEnvelopeErrorResponse,
	jsonRpcEnvelopeResponse,
	readJsonRpcEnvelope,
	requestBodyTooLargeResponse,
	validateModernFastPathRequest,
} from "./json-rpc-envelope";

import { getAllowedMcpOrigins, normalizeOrigin } from "./mcp-origin";
/**
 * MCP event surfaces the Worker answers before building a server: the
 * interaction-event extension, `subscriptions/listen`, and the internal
 * subscription publish route that forwards events to the subscription Durable
 * Object.
 */

const SUBSCRIPTIONS_LISTEN_METHOD = "subscriptions/listen";
export const MCP_EVENTS_EXTENSION = "io.modelcontextprotocol/events";

export async function maybeHandleInteractionEvents(
	request: Request,
	env: CloudflareEnv,
	enabled: boolean,
	webhooksEnabled = false,
): Promise<Response | null> {
	if (request.method !== "POST" || !enabled) return null;
	const envelope = await readJsonRpcEnvelope(request);
	if (envelope && "tooLarge" in envelope) return requestBodyTooLargeResponse();
	if (
		!envelope ||
		![
			"events/list",
			"events/poll",
			"events/subscribe",
			"events/unsubscribe",
		].includes(String(envelope.body.method))
	)
		return null;
	const violation = validateModernFastPathRequest(request, envelope);
	if (violation) return violation;
	if (
		request.headers.get("MCP-Protocol-Version") !== MCP_MODERN_PROTOCOL_VERSION
	)
		return jsonRpcEnvelopeErrorResponse(
			envelope,
			-32022,
			"Events require MCP 2026-07-28",
		);
	const params = isRecord(envelope.body.params) ? envelope.body.params : {};
	if (envelope.body.method === "events/list")
		return jsonRpcEnvelopeResponse(envelope, {
			resultType: "complete",
			events: [
				...pollableEventDefinitions.map((event) =>
					webhooksEnabled &&
					event.name !== interactionReplyEventDefinition.name &&
					event.name !== "lane.requested"
						? { ...event, delivery: ["poll", "webhook"] }
						: event,
				),
			],
		});
	const authorization = request.headers.get("Authorization");
	const resource = new URL(request.url);
	resource.pathname = "/mcp";
	resource.search = "";
	resource.hash = "";
	if (envelope.body.method === "events/poll") {
		try {
			if (!authorization?.startsWith("Bearer "))
				throw new InteractionEventError(-32024, "Human OAuth required");
			return jsonRpcEnvelopeResponse(envelope, {
				resultType: "complete",
				...(await pollEvent(
					env,
					{ authorization, mcpUrl: resource.toString() },
					params,
				)),
			});
		} catch (error) {
			return jsonRpcEnvelopeErrorResponse(
				envelope,
				error instanceof InteractionEventError ? error.code : -32603,
				error instanceof InteractionEventError
					? error.message
					: "Event operation unavailable",
				error instanceof InteractionEventError ? error.data : undefined,
			);
		}
	}
	const unsubscribing = envelope.body.method === "events/unsubscribe";
	if (
		params.name !== interactionReplyEventDefinition.name &&
		isPollableEvent(params.name) &&
		(webhooksEnabled || unsubscribing)
	) {
		try {
			if (!authorization?.startsWith("Bearer "))
				throw new InteractionEventError(-32024, "Human OAuth required");
			const caller = { authorization, mcpUrl: resource.toString() };
			return jsonRpcEnvelopeResponse(envelope, {
				resultType: "complete",
				...(unsubscribing
					? await unsubscribeEventWebhook(env, caller, params)
					: await subscribeEventWebhook(env, caller, params)),
			});
		} catch (error) {
			return jsonRpcEnvelopeErrorResponse(
				envelope,
				error instanceof InteractionEventError ? error.code : -32603,
				error instanceof InteractionEventError
					? error.message
					: "Event operation unavailable",
				error instanceof InteractionEventError ? error.data : undefined,
			);
		}
	}
	if (
		params.name !== interactionReplyEventDefinition.name &&
		isPollableEvent(params.name)
	)
		return jsonRpcEnvelopeErrorResponse(
			envelope,
			-32026,
			"This event is delivered by events/poll only",
			{ feature: "deliveryMode", value: "webhook" },
		);
	try {
		const unsubscribe = envelope.body.method === "events/unsubscribe";
		const target = interactionEventTarget(params.arguments);
		if (!authorization?.startsWith("Bearer "))
			throw new InteractionEventError(-32003, "Human OAuth required");
		const credential = {
			authorization,
			mcpUrl: resource.toString(),
			...target,
		};
		const binding = (env as McpSubscriptionBindingEnv).MCP_SUBSCRIPTIONS!;
		const response = await binding
			.get(
				binding.idFromName(
					interactionEventShard(target.organizationId, target.requestId),
				),
			)
			.fetch(
				`https://mcp-subscriptions.internal/events/${unsubscribe ? "unsubscribe" : "subscribe"}`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(
						unsubscribe ? { credential, params } : { credential, params },
					),
				},
			);
		const result = (await response.json()) as Record<string, unknown>;
		if (isRecord(result.error))
			return jsonRpcEnvelopeErrorResponse(
				envelope,
				typeof result.error.code === "number" ? result.error.code : -32603,
				typeof result.error.message === "string"
					? result.error.message
					: "Event operation unavailable",
				isRecord(result.error.data) ? result.error.data : undefined,
			);
		return jsonRpcEnvelopeResponse(envelope, {
			resultType: "complete",
			...result,
		});
	} catch (error) {
		return jsonRpcEnvelopeErrorResponse(
			envelope,
			error instanceof InteractionEventError ? error.code : -32603,
			error instanceof InteractionEventError
				? error.message
				: "Event operation unavailable",
		);
	}
}

const SUBSCRIPTION_FORWARD_HEADER_ALLOWLIST = new Set([
	"authorization",
	"x-api-key",
	"x-service-binding",
	"x-tedix-acting-user",
	"x-tedix-kernel",
	"x-tedix-org-id",
	"x-tedix-tedi-id",
	"x-tedix-skill-id",
	"x-tedix-skill-run-id",
]);

export type McpSubscriptionBindingEnv = CloudflareEnv & {
	MCP_SUBSCRIPTIONS?: DurableObjectNamespace;
};

type McpSubscriptionPublishBody = {
	kind?: "interaction_response";
	requestId?: string;
	responseId?: string;
	respondedAt?: string;
	appId?: string;
	appIds?: string[];
	organizationId?: string | null;
	method?: string;
	taskId?: string;
	state?: Record<string, unknown>;
	uri?: string;
	params?: Record<string, unknown>;
};

function collectSubscriptionForwardHeaders(
	headers: Headers,
): Record<string, string> {
	const forwarded: Record<string, string> = {};
	for (const [name, value] of headers) {
		const lower = name.toLowerCase();
		if (
			SUBSCRIPTION_FORWARD_HEADER_ALLOWLIST.has(lower) ||
			lower.startsWith("x-tedix-auth-")
		) {
			forwarded[name] = value;
		}
	}
	return forwarded;
}

async function publishSubscriptionEventToApp(
	env: CloudflareEnv,
	appId: string,
	event: Record<string, unknown>,
): Promise<number> {
	const binding = (env as McpSubscriptionBindingEnv).MCP_SUBSCRIPTIONS;
	if (!binding) return 0;
	const response = await binding
		.get(binding.idFromName(appId))
		.fetch("https://mcp-subscriptions.internal/publish", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(event),
		});
	if (!response.ok) return 0;
	const payload = (await response.json().catch(() => ({}))) as {
		delivered?: unknown;
	};
	return typeof payload.delivered === "number" ? payload.delivered : 0;
}

export async function handleInternalSubscriptionPublish(
	request: Request,
	env: CloudflareEnv,
): Promise<Response> {
	if (!isServiceBinding(request.headers)) {
		return new Response(JSON.stringify({ error: "Forbidden" }), {
			status: 403,
			headers: { "Content-Type": "application/json" },
		});
	}
	let body: McpSubscriptionPublishBody;
	try {
		body = (await request.json()) as McpSubscriptionPublishBody;
	} catch {
		return new Response(JSON.stringify({ error: "Bad Request" }), {
			status: 400,
			headers: { "Content-Type": "application/json" },
		});
	}
	if (isRecord(body) && body.kind === "interaction_response") {
		try {
			const target = interactionEventTarget({
				organization_id: body.organizationId,
				request_id: body.requestId,
			});
			const binding = (env as McpSubscriptionBindingEnv).MCP_SUBSCRIPTIONS;
			if (!binding)
				return Response.json(
					{ ok: false, error: "Event delivery unavailable" },
					{ status: 503 },
				);
			const response = await binding
				.get(
					binding.idFromName(
						interactionEventShard(target.organizationId, target.requestId),
					),
				)
				.fetch("https://mcp-subscriptions.internal/events/publish", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						...target,
						responseId: body.responseId,
						respondedAt: body.respondedAt,
					}),
				});
			const result = (await response.json()) as {
				accepted?: number;
				error?: unknown;
			};
			return Response.json(
				{ ok: response.ok && !result.error, accepted: result.accepted ?? 0 },
				{ status: response.ok && !result.error ? 200 : 503 },
			);
		} catch {
			return Response.json(
				{ ok: false, error: "Invalid reply event" },
				{ status: 400 },
			);
		}
	}
	const appIds = [
		...(typeof body.appId === "string" ? [body.appId] : []),
		...(Array.isArray(body.appIds)
			? body.appIds.filter((id): id is string => typeof id === "string")
			: []),
	].filter((id, index, all) => id && all.indexOf(id) === index);
	if (appIds.length === 0 || typeof body.method !== "string") {
		return new Response(
			JSON.stringify({ error: "appId/appIds and method are required" }),
			{ status: 400, headers: { "Content-Type": "application/json" } },
		);
	}

	let delivered = 0;
	for (const appId of appIds) {
		delivered += await publishSubscriptionEventToApp(env, appId, {
			organizationId: body.organizationId ?? null,
			method: body.method,
			...(body.taskId ? { taskId: body.taskId } : {}),
			...(body.state ? { state: body.state } : {}),
			...(body.uri ? { uri: body.uri } : {}),
			...(body.params ? { params: body.params } : {}),
		});
	}
	return new Response(JSON.stringify({ ok: true, appIds, delivered }), {
		headers: { "Content-Type": "application/json" },
	});
}

export async function maybeHandleSubscriptionsListen(
	request: Request,
	resolvedApp: ResolvedApp,
	env: CloudflareEnv,
): Promise<Response | null> {
	if (request.method !== "POST") return null;
	const envelope = await readJsonRpcEnvelope(request);
	if (envelope && "tooLarge" in envelope) return requestBodyTooLargeResponse();
	if (envelope?.body.method !== SUBSCRIPTIONS_LISTEN_METHOD) return null;

	if (request.headers.get("MCP-Protocol-Version") !== "2026-07-28") {
		return jsonRpcEnvelopeErrorResponse(
			envelope,
			-32022,
			"Unsupported protocol version: subscriptions/listen requires MCP-Protocol-Version 2026-07-28",
		);
	}
	const validationError = validateModernFastPathRequest(request, envelope);
	if (validationError) return validationError;

	const binding = (env as McpSubscriptionBindingEnv).MCP_SUBSCRIPTIONS;
	if (!binding) {
		return jsonRpcEnvelopeErrorResponse(
			envelope,
			-32601,
			"Method not found: subscriptions/listen is not configured for this MCP Worker",
		);
	}

	const allowedOrigins = getAllowedMcpOrigins(request, env, resolvedApp);
	const corsOrigin =
		normalizeOrigin(
			request.headers.get("Origin") ?? request.headers.get("origin") ?? "",
		) ??
		allowedOrigins[0] ??
		new URL(request.url).origin;
	const stub = binding.get(binding.idFromName(resolvedApp.app.id));
	return stub.fetch("https://mcp-subscriptions.internal/listen", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			requestId: envelope.body.id ?? null,
			params: isRecord(envelope.body.params) ? envelope.body.params : {},
			mcpUrl: request.url,
			authHeaders: collectSubscriptionForwardHeaders(request.headers),
			corsOrigin,
			organizationId:
				request.headers.get("x-tedix-auth-org-id") ??
				resolvedApp.app.organizationId ??
				null,
		}),
	});
}
