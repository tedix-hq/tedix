/** Authenticated STT-only WebSocket upgrade for the OS composer. */
import type { KernelVoiceInputDO } from "./kernel-voice-input-do";
import { pickEchoableSubprotocol } from "@tedix/worker-kit/request-auth";
import { authenticateKernelEdge } from "./edge-auth";

export async function handleKernelVoiceInput(
	request: Request,
	env: CloudflareEnv,
): Promise<Response> {
	if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
		return Response.json({
			status: "ok",
			service: "kernel-voice-input",
			transport: "websocket",
		});
	}
	const namespace = (
		env as {
			KERNEL_VOICE_INPUT?: DurableObjectNamespace<KernelVoiceInputDO>;
		}
	).KERNEL_VOICE_INPUT;
	if (!namespace)
		return Response.json(
			{
				error: "Service Unavailable",
				message: "Voice input is not configured",
			},
			{ status: 503 },
		);
	const auth = await authenticateKernelEdge(request, env);
	if (!auth.ok) return auth.response;
	const headers = new Headers(request.headers);
	headers.set("X-Kernel-Descope-User-Id", auth.identity.descopeUserId);
	headers.set("X-Kernel-Organization-Id", auth.identity.organizationId);
	const url = new URL(request.url);
	url.searchParams.set("organization", auth.identity.organizationId);
	const stub = namespace.get(
		namespace.idFromName(`${auth.identity.organizationId}:dictation`),
	);
	const response = await stub.fetch(
		new Request(url.toString(), { ...request, headers }),
	);
	const protocol = pickEchoableSubprotocol(
		request.headers.get("Sec-WebSocket-Protocol"),
	);
	if (
		protocol &&
		response.status === 101 &&
		response.webSocket &&
		!response.headers.get("Sec-WebSocket-Protocol")
	) {
		const echoed = new Headers(response.headers);
		echoed.set("Sec-WebSocket-Protocol", protocol);
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers: echoed,
			webSocket: response.webSocket,
		});
	}
	return response;
}
