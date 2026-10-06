/**
 * `GET /kernel/voice/call` — WebSocket upgrade into `KernelVoiceDO` for live
 * browser voice calls on the kernel.
 *
 * Authentication is owned by edge-auth.ts:
 *   - Scoped kernel WS token (HMAC, minted by `GET /kernel/ws-token`) primary.
 *   - Descope session JWT fallback.
 *   - Token via `Authorization: Bearer` or `Sec-WebSocket-Protocol: bearer-<token>`.
 *   - Query-param tokens rejected (would leak into access logs).
 *   - Org/user identity stamped on the DO upgrade request as
 *     `X-Kernel-Descope-User-Id` / `X-Kernel-Organization-Id`.
 *   - Bearer subprotocol echoed on the 101 (browser WebSocket requirement).
 *
 * DO addressing: `KERNEL_VOICE.idFromName(`${organizationId}:${conversation}`)`.
 * The `conversation` param defaults to `"home:main"`.
 *
 * Tedix OS client contract:
 *   wss://{apiHost}/kernel/voice/call?organization={orgId}&conversation=home:main
 *   Sec-WebSocket-Protocol: bearer-<token>
 */

import type { KernelVoiceDO } from "./kernel-voice-do";
import { pickEchoableSubprotocol } from "@tedix/worker-kit/request-auth";
import { authenticateKernelEdge, jsonError } from "./edge-auth";

export async function handleKernelVoiceCall(
	request: Request,
	env: CloudflareEnv,
): Promise<Response> {
	const upgrade = request.headers.get("Upgrade")?.toLowerCase();
	if (upgrade !== "websocket") {
		// Plain GET → capability probe (no auth, no DO touch).
		return Response.json({
			status: "ok",
			service: "kernel-voice",
			transport: "websocket",
		});
	}

	const kernelVoice = (
		env as { KERNEL_VOICE?: DurableObjectNamespace<KernelVoiceDO> }
	).KERNEL_VOICE;
	if (!kernelVoice) {
		return jsonError(
			503,
			"Service Unavailable",
			"Kernel voice binding is not configured",
		);
	}

	// Authenticate before resolving the Durable Object.
	const authResult = await authenticateKernelEdge(request, env);
	if (!authResult.ok) return authResult.response;
	const { identity } = authResult;

	const url = new URL(request.url);
	const conversation = url.searchParams.get("conversation") ?? "home:main";

	// Stamp the validated identity on the DO upgrade request (KernelVoiceDO reads
	// these in onConnect via connection.request?.headers).
	const headers = new Headers(request.headers);
	headers.set("X-Kernel-Descope-User-Id", identity.descopeUserId);
	headers.set("X-Kernel-Organization-Id", identity.organizationId);

	// Stamp the org + conversation as query params so the DO can also read them
	// from the upgrade URL (belt-and-braces for the same-instance path).
	const doUrl = new URL(request.url);
	doUrl.searchParams.set("organization", identity.organizationId);
	doUrl.searchParams.set("conversation", conversation);

	const stub = kernelVoice.get(
		kernelVoice.idFromName(`${identity.organizationId}:${conversation}`),
	);
	const doRequest = new Request(doUrl.toString(), { ...request, headers });
	const doResponse = await stub.fetch(doRequest);

	// Subprotocol echo on the 101 — echo one offered protocol.
	const acceptedProtocol = pickEchoableSubprotocol(
		request.headers.get("Sec-WebSocket-Protocol"),
	);
	if (
		acceptedProtocol &&
		doResponse.status === 101 &&
		doResponse.webSocket &&
		!doResponse.headers.get("Sec-WebSocket-Protocol")
	) {
		const echoedHeaders = new Headers(doResponse.headers);
		echoedHeaders.set("Sec-WebSocket-Protocol", acceptedProtocol);
		return new Response(doResponse.body, {
			status: doResponse.status,
			statusText: doResponse.statusText,
			headers: echoedHeaders,
			webSocket: doResponse.webSocket,
		});
	}
	return doResponse;
}
