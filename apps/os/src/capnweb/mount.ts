/**
 * Cap'n Web mount for OS Chat.
 *
 * Route contract (wired by `worker.ts`): `/capn` on a provisioned TENANT host,
 * after tenant resolution, so `hostTenantId` is the host-resolved Descope
 * tenant id — never a caller-supplied header. `worker.ts` owns the host and
 * session refusals; the browser's localStorage key is a per-operator preference
 * and was never a gate.
 *
 * Everything below is a refusal that happens BEFORE a socket exists, in this
 * order — each one is a 4xx, not a 101:
 *
 * 1. WebSocket upgrade only. A non-upgrade request is refused with 426 before
 *    any capnweb code runs. This is also why `newWorkersWebSocketRpcResponse`
 *    is imported directly instead of `newWorkersRpcResponse`: the latter
 *    serves capnweb's HTTP-batch mode on POST *before* it checks the upgrade
 *    header, and that mode also sets `Access-Control-Allow-Origin: *`. The
 *    session lifecycle (limits, subscriptions, disposal) must stay socket-bound.
 *
 * 2. Same-origin `Origin`. capnweb's own docs warn that its Workers entry
 *    accepts cross-origin requests and that the caller must validate `Origin`
 *    unless authorization is IN-BAND. This lane is not in-band: credentials are
 *    lifted from the ambient upgrade request, which is exactly the cookie case
 *    the warning targets. The same-origin policy does not gate WebSocket
 *    handshakes and there is no preflight, so without this check any same-site
 *    origin (`*.tedix.dev` under the DS cookie's `SameSite=Lax` domain) could
 *    open a foreign tenant's socket with the victim's cookies and READ every
 *    frame — the protection `/api/*` gets for free from SOP response blocking.
 *    A missing `Origin` is refused too: browsers always send one on a handshake.
 *
 * 3. Authorization pre-flight. The caller's OWN credentials must complete one
 *    canonical read in the host tenant before the upgrade is granted (the same
 *    shape `handleCollabUpgrade` uses). Unauthenticated, foreign-tenant, and
 *    non-member callers collapse into one 403 so tenant existence does not leak
 *    at the socket layer. Without it, `newWorkersWebSocketRpcResponse` answers
 *    101 to anyone and refusal only happens per-RPC, downstream.
 *
 * Credentials: only the caller's own `Authorization` and `Cookie` headers are
 * captured (same allowlist as the collab upgrade), plus `CF-Connecting-IP` so
 * apps/api's `byCredentialOrIp` limiter still has a key — a cookie-only session
 * with no client IP falls into one shared `"unknown"` bucket across all tenants.
 * Browsers cannot set headers on WebSocket upgrades, so the browser path rides
 * on same-origin cookies; apps/api re-derives every authorization decision from
 * these forwarded credentials plus the host-asserted tenant.
 */

import { callRpc, serviceBindingFetch } from "@tedix/api-client/internal";
import { newWorkersWebSocketRpcResponse } from "capnweb";
import {
	CAPN_REQUEST_ERROR_NAME,
	CapnChatSession,
	type CapnSessionEnv,
} from "./session-root";

/**
 * Receiver-side deserialization limits. capnweb's defaults allow a 32 MiB
 * frame, which is accepted and deserialized BEFORE `MAX_MESSAGE_BYTES` (a
 * payload check on `enqueue` alone) can look at it. 256 KiB is an order of
 * magnitude above the largest legitimate call on this surface.
 */
export const CAPN_MAX_WIRE_BYTES = 256 * 1024;
/** Nesting cap; the deepest legitimate argument here is two levels. */
export const CAPN_MAX_DEPTH = 32;

/** Preflight timeout: an upgrade must not hang on a slow authority. */
const AUTHORIZE_TIMEOUT_MS = 5_000;

function refuse(status: number, message: string): Response {
	return new Response(`${message}\n`, {
		status,
		headers: { "Content-Type": "text/plain; charset=utf-8" },
	});
}

/** Caller-credential allowlist — mirrors worker.ts's collab upgrade. */
/**
 * Credentials forwarded from the handshake: the session cookie ONLY.
 *
 * `Authorization` is deliberately NOT forwarded. This lane is a
 * cookie-authenticated browser transport whose organization is decided by the
 * HOSTNAME, but apps/api resolves an API key or tedi JWT to that credential's
 * OWN organization and never consults `X-Tedix-Tenant-Id`. Forwarding a bearer
 * credential therefore let a caller open a session on any tenant's hostname
 * and run it in their own org — the host-binding invariant silently inverted.
 * Bearer principals have the API and MCP surfaces, which are built for them.
 */
export function buildCredentialHeaders(
	request: Request,
	options: { localDemo?: boolean } = {},
): Record<string, string> {
	const headers: Record<string, string> = {};
	const cookie = request.headers.get("Cookie");
	const clientIp = request.headers.get("CF-Connecting-IP");
	if (cookie) headers.Cookie = cookie;
	// LOCAL-DEMO EXCEPTION to the no-bearer rule above: zero-account local
	// development has no cookie session at all — `worker.ts` injects the
	// deterministic loopback-only bearer (`withLocalDemoAuthorization`), and
	// there is no tenant whose host-binding a bearer could invert. This is the
	// only mode that forwards Authorization.
	if (options.localDemo === true) {
		const authorization = request.headers.get("Authorization");
		if (authorization) headers.Authorization = authorization;
	}
	// Rate-limit key for apps/api's byCredentialOrIp: a service-binding
	// subrequest carries no client IP of its own.
	if (clientIp) headers["CF-Connecting-IP"] = clientIp;
	return headers;
}

/**
 * True when the handshake's `Origin` is this exact origin. Absent, malformed,
 * and foreign origins are all false — a browser always sends `Origin` on a
 * WebSocket handshake, so absence is not a same-origin signal.
 */
export function isSameOriginUpgrade(request: Request): boolean {
	const origin = request.headers.get("Origin");
	if (origin === null || origin === "") return false;
	let parsed: URL;
	try {
		parsed = new URL(origin);
	} catch {
		return false;
	}
	return parsed.origin === new URL(request.url).origin;
}

/**
 * Upgrade the request into a Cap'n Web RPC session rooted at a
 * `CapnChatSession` bound to the host tenant and the caller's credentials.
 * Refuses 426 / 403 / 503 before any socket exists.
 */
export async function mountCapnChat(
	request: Request,
	env: CapnSessionEnv,
	hostTenantId: string | null,
	options: { localDemo?: boolean } = {},
): Promise<Response> {
	const localDemo = options.localDemo === true;
	if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
		return refuse(426, "Expected a WebSocket upgrade.");
	}
	if (!isSameOriginUpgrade(request)) {
		return refuse(403, "Cross-origin Cap'n Web upgrades are refused.");
	}
	if (!env.API_SERVICE) {
		return refuse(
			503,
			"The Cap'n Web transport is unavailable on this origin.",
		);
	}
	// The HOSTNAME decides the organization for this lane, so a host that
	// resolves to no Descope tenant cannot be bound and must not fall through
	// to the caller's own default org — that would run a session in the
	// caller's organization from a foreign tenant's hostname. Local demo is the
	// one exception: a loopback origin has no Descope tenant by design, and the
	// deterministic local identity resolves its own org.
	if (!hostTenantId && !localDemo) {
		return refuse(403, "You do not have access to this workspace.");
	}
	const credentialHeaders = buildCredentialHeaders(request, { localDemo });
	const headers: Record<string, string> = hostTenantId
		? { ...credentialHeaders, "X-Tedix-Tenant-Id": hostTenantId }
		: { ...credentialHeaders };
	try {
		// The caller's OWN credentials authorize this socket — never a
		// service-binding claim, which would evaluate the call without the
		// user's org context. apps/api proves membership in the asserted tenant.
		await callRpc(
			"kernelRuntime/listConversations",
			{ limit: 1 },
			{
				apiUrl: "https://api",
				fetch: serviceBindingFetch(env.API_SERVICE),
				headers,
				timeoutMs: AUTHORIZE_TIMEOUT_MS,
			},
		);
	} catch {
		// Unauthenticated, foreign-org, and not-a-member all collapse to one
		// refusal: tenant existence must not leak at the socket layer.
		return refuse(403, "You do not have access to this workspace.");
	}
	return newWorkersWebSocketRpcResponse(
		request,
		new CapnChatSession({ env, hostTenantId, credentialHeaders }),
		{
			limits: {
				maxMessageSize: CAPN_MAX_WIRE_BYTES,
				maxDepth: CAPN_MAX_DEPTH,
			},
			// Redaction: capnweb serializes thrown errors verbatim to the peer
			// (message AND stack), which would ship upstream oRPC text and
			// internal binding detail into the browser. Only this root's own
			// contract refusals — cursor/argument validation and the session
			// limits — are the peer's business; everything else collapses to a
			// generic refusal, with the detail kept in this Worker's logs.
			onSendError: (error) => {
				if (error.name === CAPN_REQUEST_ERROR_NAME) return error;
				console.error(`capnweb session error: ${error.message}`);
				return new Error("The Cap'n Web call failed.");
			},
		},
	);
}
