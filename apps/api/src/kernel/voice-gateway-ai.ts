import { isRecord } from "@tedix/api-contract/utils/is-record";
import { logKernelVoiceFailure } from "./kernel-voice-log";

/**
 * apps/api — Gateway-routed Workers AI runner for kernel live voice.
 *
 * Every live-voice inference is routed through Cloudflare AI Gateway when the
 * provider supports it. Direct provider-usage recording remains authoritative
 * for internal attribution because Gateway log coverage can omit voice calls:
 *   - `voice-stt` — `@cf/deepgram/flux` realtime transcription (WebSocket)
 *   - `voice-tts` — Workers AI TTS synthesis
 *
 * The wrapper fails closed: a missing `AI_GATEWAY_LLM_ID` raises at call time
 * instead of silently running raw (Gateway-invisible) Workers AI inference.
 */

/** Minimal Workers AI binding surface. */
export type AiRunner = {
	/** Most recent AI Gateway log id exposed by the Workers AI binding. */
	aiGatewayLogId?: string;
	run(
		model: string,
		input: Record<string, unknown>,
		options?: Record<string, unknown>,
	): Promise<unknown>;
};

export type VoiceChannel = "voice-stt" | "voice-tts";

/** Per-call attribution resolved lazily at inference time. */
export interface VoiceCallAttribution {
	organizationId?: string;
	sessionId?: string;
}

export interface VoiceGatewayAiConfig {
	ai: () => AiRunner;
	gatewayId: () => string | undefined;
	channel: VoiceChannel;
	attribution: () => VoiceCallAttribution | null;
	afterRun?: (event: {
		channel: VoiceChannel;
		model: string;
		input: Record<string, unknown>;
		result: unknown;
		gatewayLogId: string | null;
	}) => void | Promise<void>;
}

function usageEnvelope(
	channel: VoiceChannel,
	input: Record<string, unknown>,
): string {
	if (channel === "voice-tts") {
		const text = typeof input.text === "string" ? input.text : "";
		return JSON.stringify({
			k: "voice_tts",
			u: "characters",
			q: Math.max(1, text.length),
		});
	}
	// Flux opens one realtime WebSocket session per call; duration is unknown
	// at request time, so meter one provider unit per session.
	return JSON.stringify({ k: "voice_stt", u: "units", q: 1 });
}

export function createVoiceGatewayAi(config: VoiceGatewayAiConfig): AiRunner {
	return {
		run: async (model, input, options) => {
			const gatewayId = config.gatewayId()?.trim();
			if (!gatewayId) {
				throw new Error(
					`[KernelVoice] AI_GATEWAY_LLM_ID is not configured; refusing raw Workers AI ${config.channel} inference`,
				);
			}
			const callerOptions = isRecord(options) ? options : {};
			const callerGateway = isRecord(callerOptions.gateway)
				? callerOptions.gateway
				: {};
			const callerMetadata = isRecord(callerGateway.metadata)
				? callerGateway.metadata
				: {};
			const active = config.attribution() ?? {};
			// Gateway custom metadata is capped at five entries; this envelope uses
			// exactly channel/source/orgId/sessionId/usage. Caller-supplied metadata
			// and gateway options win on key collisions — except the gateway id,
			// which is the enforced route.
			const metadata: Record<string, unknown> = {
				channel: config.channel,
				source: config.channel,
				...(active.organizationId ? { orgId: active.organizationId } : {}),
				...(active.sessionId ? { sessionId: active.sessionId } : {}),
				usage: usageEnvelope(config.channel, input),
				...callerMetadata,
			};
			const ai = config.ai();
			const priorGatewayLogId = ai.aiGatewayLogId?.trim() || null;
			const result = await ai.run(model, input, {
				...callerOptions,
				gateway: { ...callerGateway, id: gatewayId, metadata },
			});
			try {
				await config.afterRun?.({
					channel: config.channel,
					model,
					input,
					result,
					gatewayLogId:
						ai.aiGatewayLogId?.trim() &&
						ai.aiGatewayLogId.trim() !== priorGatewayLogId
							? ai.aiGatewayLogId.trim()
							: null,
				});
			} catch (error) {
				// Observability must never convert successful provider inference into
				// a user-visible voice failure. The callback owns durable error logs.
				logKernelVoiceFailure("voice.gateway_observer_failed", error, {
					channel: config.channel,
				});
			}
			return result;
		},
	};
}
