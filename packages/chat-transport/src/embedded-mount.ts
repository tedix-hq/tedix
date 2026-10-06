import { newWorkersWebSocketRpcResponse } from "capnweb";
import {
	EmbeddedRoot,
	EMBEDDED_SESSION_EXPIRED_MESSAGE,
	type EmbeddedCapabilityAdapter,
} from "./embedded-capability";

import {
	EMBEDDED_STREAM_CURSOR_REJECTED,
	EMBEDDED_STREAM_NOT_STARTED_EXPIRED,
} from "./embedded-contract";

/** WebSocket-only, in-band auth. No cookie authority and no wildcard HTTP RPC. */
export function mountEmbeddedCapability(
	request: Request,
	adapter: EmbeddedCapabilityAdapter,
): Response {
	if (
		request.method !== "GET" ||
		request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
	) {
		return new Response("WebSocket required", { status: 426 });
	}
	const origin = request.headers.get("Origin");
	if (!origin || origin === "null")
		return new Response("Forbidden", { status: 403 });
	try {
		const parsed = new URL(origin);
		if (parsed.origin !== origin || parsed.protocol !== "https:")
			return new Response("Forbidden", { status: 403 });
	} catch {
		return new Response("Forbidden", { status: 403 });
	}
	return newWorkersWebSocketRpcResponse(request, new EmbeddedRoot(adapter), {
		limits: { maxMessageSize: 128 * 1024, maxDepth: 32 },
		onSendError(error) {
			console.error("[embedded-capn] request failed", error);
			// Fixed protocol signals distinguish expiry and rejected resume cursors.
			// Never forward arbitrary provider errors or attached details.
			return new Error(
				error instanceof Error &&
					(error.message === EMBEDDED_SESSION_EXPIRED_MESSAGE ||
						error.message === EMBEDDED_STREAM_NOT_STARTED_EXPIRED ||
						error.message === EMBEDDED_STREAM_CURSOR_REJECTED)
					? error.message
					: "The embedded capability call failed.",
			);
		},
	});
}
