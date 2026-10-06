/**
 * voice-tts — Worker-side text-to-speech for ASSISTANT SPOKEN REPLIES.
 *
 * Used by the API voice router and Agent-runtime speech endpoint. Callers
 * own playback and caching; this helper synthesizes one response per call.
 *
 * Two providers behind one interface
 * (mirrors stt.ts's Azure-preferred-with-Workers-AI-fallback shape):
 *   1. Azure `gpt-4o-mini-tts` through the authenticated Tedix AI Gateway.
 *      Cloudflare Gateway BYOK supplies the Azure key.
 *   2. Workers AI `@cf/deepgram/aura-1` via the `AI` binding (no-key fallback) —
 *      the SAME TTS the live-call pipeline uses.
 *
 * On any Azure error/timeout we fall back to Workers AI Aura at runtime, so a
 * slow/broken Azure endpoint can't sink the spoken reply. `env.AI` is always
 * present, so Aura is always reachable.
 *
 * Azure is gateway-only. Missing Gateway configuration selects Workers AI;
 * there is intentionally no direct-Azure credential fallback.
 */

import {
	type AiGatewayTransport,
	resolveAiGatewayTransport,
} from "@tedix/workers-ai/gateway-transport";

/** Max characters synthesized per call — TTS providers cap input; keep spoken
 * replies short and bounded. Longer assistant text is truncated at a sentence-ish
 * boundary by the caller, or hard-capped here as a backstop. */
export const MAX_TTS_CHARS = 4000;

/** Abort the Azure TTS request after this long so a slow/unreachable endpoint
 * falls back to Workers AI Aura instead of hanging the request. */
const AZURE_TTS_TIMEOUT_MS = 20_000;

const DEFAULT_AZURE_TTS_DEPLOYMENT = "gpt-4o-mini-tts";
const DEFAULT_AZURE_TTS_VOICE = "nova";
const DEFAULT_AZURE_TTS_API_VERSION = "2025-01-01-preview";
const DEFAULT_AURA_SPEAKER = "asteria";

/** Minimal env surface the helper needs. All Azure + gateway fields optional so
 * TTS degrades to Workers AI (or fails soft) when they are absent. */
export interface VoiceTtsEnv {
	/**
	 * Workers AI binding. Serves the Workers AI TTS fallback AND, for every
	 * provider listed in `AI_GATEWAY_BINDING_PROVIDERS`, the AI Gateway transport
	 * itself — see `@tedix/workers-ai/gateway-transport`.
	 */
	AI: Ai;
	AZURE_OPENAI_RESOURCE?: string;
	AZURE_OPENAI_TTS_DEPLOYMENT?: string;
	AZURE_OPENAI_TTS_VOICE?: string;
	AZURE_OPENAI_TTS_API_VERSION?: string;
	AI_GATEWAY_ACCOUNT_ID?: string;
	AI_GATEWAY_LLM_ID?: string;
	CF_AI_GATEWAY_TOKEN?: string;
	/**
	 * Comma-separated allowlist of AI Gateway provider segments served by an
	 * in-account gateway, which therefore ride the Workers AI binding instead of
	 * public HTTPS. Listing `azure-openai` routes Azure TTS over the binding.
	 */
	AI_GATEWAY_BINDING_PROVIDERS?: string;
}

export type TtsProvider = "azure" | "workers-ai";

export interface SpeechResult {
	audio: Uint8Array;
	/** Best-effort container hint; the browser sniffs the real format on play. */
	mimeType: string;
	provider: TtsProvider;
}

export interface SynthesizeOptions {
	text: string;
	/** Override the speaker/voice; defaults to the platform voice per provider. */
	voice?: string;
	/** Flat primitive Gateway metadata, capped with `channel` to five entries. */
	gatewayMetadata?: Record<string, string | number | boolean | undefined>;
}

export class TtsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TtsError";
	}
}

/** True when authenticated AI Gateway BYOK can serve Azure TTS. */
export function azureTtsTransport(env: VoiceTtsEnv): AiGatewayTransport | null {
	const gatewayId = env.AI_GATEWAY_LLM_ID?.trim();
	if (!env.AZURE_OPENAI_RESOURCE?.trim() || !gatewayId) return null;
	return resolveAiGatewayTransport(env, gatewayId, "azure-openai");
}

export function hasAzureTts(env: VoiceTtsEnv): boolean {
	return azureTtsTransport(env) !== null;
}

/** True when AI Gateway is fully configured (both vars set). */
export function hasAiGateway(env: VoiceTtsEnv): boolean {
	return Boolean(env.AI_GATEWAY_ACCOUNT_ID && env.AI_GATEWAY_LLM_ID);
}

/** Trim + hard-cap the input so providers don't reject an over-length body. */
export function clampTtsText(text: string): string {
	const flat = text.trim();
	if (flat.length <= MAX_TTS_CHARS) return flat;
	return `${flat.slice(0, MAX_TTS_CHARS - 1).trimEnd()}…`;
}

function azureSpeechUrl(
	env: VoiceTtsEnv,
	transport: AiGatewayTransport,
): string {
	const resource = env.AZURE_OPENAI_RESOURCE as string;
	const deployment =
		env.AZURE_OPENAI_TTS_DEPLOYMENT ?? DEFAULT_AZURE_TTS_DEPLOYMENT;
	const apiVersion =
		env.AZURE_OPENAI_TTS_API_VERSION ?? DEFAULT_AZURE_TTS_API_VERSION;
	const query = `?api-version=${encodeURIComponent(apiVersion)}`;
	return `${transport.providerRoot}/${resource}/${deployment}/audio/speech${query}`;
}

function gatewayMetadata(
	metadata?: SynthesizeOptions["gatewayMetadata"],
): Record<string, string | number | boolean> {
	return Object.fromEntries([
		["channel", "voice-tts"],
		...Object.entries(metadata ?? {})
			.filter(
				(entry): entry is [string, string | number | boolean] =>
					entry[1] !== undefined &&
					(typeof entry[1] === "string" ||
						typeof entry[1] === "number" ||
						typeof entry[1] === "boolean"),
			)
			.slice(0, 4),
	]);
}

async function synthesizeAzure(
	env: VoiceTtsEnv,
	text: string,
	voice: string | undefined,
	metadata?: SynthesizeOptions["gatewayMetadata"],
): Promise<Uint8Array> {
	const transport = azureTtsTransport(env);
	if (!transport) {
		throw new TtsError("Azure TTS requires authenticated AI Gateway BYOK");
	}
	const url = azureSpeechUrl(env, transport);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), AZURE_TTS_TIMEOUT_MS);
	let res: Response;
	try {
		res = await transport.fetch(url, {
			method: "POST",
			headers: {
				// On the binding transport this is the pre-authenticated sentinel.
				"cf-aig-authorization": `Bearer ${transport.authorization}`,
				"cf-aig-metadata": JSON.stringify(gatewayMetadata(metadata)),
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: env.AZURE_OPENAI_TTS_DEPLOYMENT ?? DEFAULT_AZURE_TTS_DEPLOYMENT,
				input: text,
				voice: voice ?? env.AZURE_OPENAI_TTS_VOICE ?? DEFAULT_AZURE_TTS_VOICE,
				response_format: "mp3",
			}),
			signal: controller.signal,
		});
	} catch (err) {
		if (controller.signal.aborted) {
			throw new TtsError(`Azure TTS timed out after ${AZURE_TTS_TIMEOUT_MS}ms`);
		}
		throw new TtsError(
			`Azure TTS request failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	} finally {
		clearTimeout(timer);
	}
	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		throw new TtsError(
			`Azure TTS failed (${res.status})${detail ? `: ${detail.slice(0, 300)}` : ""}`,
		);
	}
	const buf = await res.arrayBuffer();
	if (buf.byteLength === 0) throw new TtsError("Azure TTS returned no audio");
	return new Uint8Array(buf);
}

/** Coerce the various shapes Workers AI audio models return into bytes. */
async function coerceAudioBytes(out: unknown): Promise<Uint8Array> {
	if (out instanceof Uint8Array) return out;
	if (out instanceof ArrayBuffer) return new Uint8Array(out);
	if (out instanceof ReadableStream) {
		return new Uint8Array(await new Response(out).arrayBuffer());
	}
	if (out instanceof Response) {
		return new Uint8Array(await out.arrayBuffer());
	}
	if (out && typeof out === "object" && "audio" in out) {
		return coerceAudioBytes((out as { audio: unknown }).audio);
	}
	throw new TtsError("Workers AI TTS returned no recognizable audio");
}

async function synthesizeWorkersAi(
	env: VoiceTtsEnv,
	text: string,
	voice: string | undefined,
	metadata?: SynthesizeOptions["gatewayMetadata"],
): Promise<Uint8Array> {
	const options = hasAiGateway(env)
		? {
				gateway: {
					id: env.AI_GATEWAY_LLM_ID as string,
					metadata: gatewayMetadata(metadata),
				},
			}
		: undefined;
	// Loosen the binding type for this call: workers-types pins the aura `speaker`
	// to a closed voice union, but `voice` is an arbitrary caller override (and a
	// future provider may accept others), so route through a generic runner.
	const ai = env.AI as unknown as {
		run(
			model: string,
			input: Record<string, unknown>,
			options?: Record<string, unknown>,
		): Promise<unknown>;
	};
	const out = await ai.run(
		"@cf/deepgram/aura-1",
		{ text, speaker: voice ?? DEFAULT_AURA_SPEAKER },
		options,
	);
	const bytes = await coerceAudioBytes(out);
	if (bytes.byteLength === 0) {
		throw new TtsError("Workers AI Aura returned no audio");
	}
	return bytes;
}

/**
 * Synthesize ONE spoken rendition of `text`. Azure is preferred when its creds
 * exist; on an Azure error/timeout we fall back to Workers AI Aura at runtime.
 * Throws {@link TtsError} only when BOTH providers fail — the caller fails soft.
 */
export async function synthesizeSpeech(
	env: VoiceTtsEnv,
	opts: SynthesizeOptions,
): Promise<SpeechResult> {
	const text = clampTtsText(opts.text);
	if (!text) throw new TtsError("text is required");
	if (hasAzureTts(env)) {
		try {
			const audio = await synthesizeAzure(
				env,
				text,
				opts.voice,
				opts.gatewayMetadata,
			);
			return { audio, mimeType: "audio/mpeg", provider: "azure" };
		} catch (azureErr) {
			const reason =
				azureErr instanceof Error ? azureErr.message : String(azureErr);
			console.warn(
				`[voice-tts] Azure TTS failed, falling back to Workers AI Aura: ${reason}`,
			);
		}
	}
	const audio = await synthesizeWorkersAi(
		env,
		text,
		opts.voice,
		opts.gatewayMetadata,
	);
	return { audio, mimeType: "audio/mpeg", provider: "workers-ai" };
}
