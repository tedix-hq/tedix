import type { Hono } from "hono";

export function registerKernelRoutes(app: Hono<{ Bindings: CloudflareEnv }>) {
	/** Mint a short-lived voice token using validated user-session organization scope. */
	app.get("/kernel/ws-token", async (c) => {
		const { handleKernelWsToken } = await import("../kernel/ws-token-route");
		return handleKernelWsToken(c.req.raw, c.env);
	});

	/**
	 * Kernel voice call WebSocket upgrade — connects the browser's voice client to
	 * `KernelVoiceDO`, keyed `${organizationId}:${conversation}`. The DO runs live
	 * STT (Flux) → kernel turn (startKernelTurn + runKernelTurnWork, same persist-
	 * first pipeline as Home turns) → TTS (Aura) on every utterance.
	 *
	 * Auth: shared kernel edge policy (scoped kernel WS token primary, Descope
	 * session JWT fallback — see edge-auth.ts for the auth contract).
	 *
	 * Query params:
	 *   ?organization=<D1 org UUID>  — resolved/verified by auth; matches token scope
	 *   ?conversation=<key>          — defaults to "home:main"
	 *
	 * Tedix OS client:
	 *   wss://{apiHost}/kernel/voice/call?organization={orgId}&conversation=home:main
	 *   Sec-WebSocket-Protocol: bearer-<token>
	 *
	 * Deliberately OUTSIDE the /rpc/* and /v1/* rate-limiter scopes — long-lived WS
	 * upgrades must not consume the per-credential request budget.
	 */
	app.get("/kernel/voice/call", async (c) => {
		const { handleKernelVoiceCall } = await import("../kernel/voice-route");
		return handleKernelVoiceCall(c.req.raw, c.env);
	});

	// authz: public plain GET is a capability probe; WebSocket upgrades authenticate in the handler
	app.get("/kernel/voice/input", async (c) => {
		const { handleKernelVoiceInput } =
			await import("../kernel/voice-input-route");
		return handleKernelVoiceInput(c.req.raw, c.env);
	});

	app.post("/kernel/voice/transcribe", async (c) => {
		const { handleKernelVoiceTranscription } =
			await import("../kernel/voice-transcription-route");
		return handleKernelVoiceTranscription(c.req.raw, c.env);
	});
}
