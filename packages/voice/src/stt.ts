/**
 * voice-stt — Worker-side speech-to-text for ASYNC VOICE NOTES.
 *
 * API kernel and Agent-runtime dispatch paths transcribe the first
 * `audio` attachment here before running the normal text turn. Callers
 * may still receive the raw attachment for their own media handling, but the
 * model-facing turn text gets the same Tedix-owned transcript block everywhere.
 *
 * Two providers behind one interface:
 *   1. Azure `gpt-transcribe` through the authenticated Tedix AI
 *      Gateway (preferred). Cloudflare Gateway BYOK supplies the Azure key;
 *      this package never receives or forwards the provider credential.
 *   2. Workers AI `@cf/openai/whisper` via the `AI` binding (no-key fallback).
 *
 * Azure is gateway-only. Missing Gateway configuration selects Workers AI;
 * there is intentionally no direct-Azure credential fallback.
 */

import {
	type AiGatewayTransport,
	resolveAiGatewayTransport,
} from "@tedix/workers-ai/gateway-transport";

/** Hard cap on attachment payload — keeps a runaway upload from blowing the
 * Worker memory/CPU budget. Tedix OS sends the browser's native recording container
 * (webm/opus, ogg/opus, or mp4); the STT providers sniff the actual format. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25 MiB (matches OpenAI STT limit)

/**
 * Per-image byte cap for INLINING an image into the model turn. An image over
 * this size falls back to the filename note instead of bloating the context
 * window with megabytes of base64 (each base64 char is ~1 token to the model).
 * Tuned below typical vision-model per-image limits while protecting the turn
 * budget. R2-referenced images (URL content) are NOT inlined and bypass this.
 */
export const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MiB

/**
 * Max images attached to a single turn that we surface to the model as image
 * parts. Extra images beyond this cap fall back to the filename note so a turn
 * cannot smuggle an unbounded number of images past the context budget.
 */
export const MAX_TURN_IMAGES = 4;

/** Image mime types we hand to the (multimodal) model as image content parts.
 * Anything else — including image/* types outside this set — falls back to the
 * filename note rather than risk an unsupported-format model error. */
const SUPPORTED_IMAGE_MIME = new Set([
	"image/png",
	"image/jpeg",
	"image/jpg",
	"image/webp",
	"image/gif",
]);

/**
 * A model-facing image content part resolved from an attachment. Provider-
 * agnostic on purpose: callers map it to the AI SDK `{type:"image"}` part OR
 * the raw Azure `{type:"image_url"}` part. `kind:"url"` means the image is
 * already stored/hosted (R2 reference or data URL) and should be passed by
 * reference; `kind:"base64"` carries the raw base64 to inline.
 */
export interface TurnImagePart {
	kind: "base64" | "url";
	/** Raw base64 (no `data:` prefix) for `kind:"base64"`, or the URL string. */
	data: string;
	mediaType: string;
	fileName: string;
}

/** Normalize a mime type: lowercase, strip any `;charset=...` parameter. */
function normalizeMime(mimeType: string): string {
	return ((mimeType || "").toLowerCase().split(";")[0] ?? "").trim();
}

/** True when an attachment content string is already a hosted/data URL
 * reference (preferred over inlining — protects the context window). */
function isUrlReference(content: string): boolean {
	return (
		content.startsWith("https://") ||
		content.startsWith("http://") ||
		content.startsWith("data:")
	);
}

/**
 * Decoded byte length of a base64 string without materializing the bytes.
 * Accounts for `=` padding. Used to enforce {@link MAX_INLINE_IMAGE_BYTES}
 * cheaply before we decide to inline.
 */
function base64ByteLength(b64: string): number {
	const len = b64.length;
	if (len === 0) return 0;
	let padding = 0;
	if (b64.endsWith("==")) padding = 2;
	else if (b64.endsWith("=")) padding = 1;
	return Math.floor((len * 3) / 4) - padding;
}

export interface ResolveTurnImagesResult {
	/** Images eligible to send to the model, capped at {@link MAX_TURN_IMAGES}. */
	images: TurnImagePart[];
	/** Attachments that did NOT become image parts (non-image, oversized,
	 * unsupported mime, malformed, or over the count cap) and must still be
	 * surfaced via the filename note so they are never silently dropped. */
	fellBack: AudioAttachment[];
}

/**
 * FAIL-SOFT image resolution for a chat turn. Pure + synchronous so it is
 * trivially unit-testable. Audio attachments are ignored here (the STT path
 * owns them). For every non-audio attachment:
 *   - non-image mime  → fall back (filename note)
 *   - image/* outside {@link SUPPORTED_IMAGE_MIME} → fall back
 *   - already a URL/data reference → emit a `url` image part (no size check)
 *   - base64 over {@link MAX_INLINE_IMAGE_BYTES} → fall back
 *   - empty/malformed content → fall back
 * and any image beyond {@link MAX_TURN_IMAGES} falls back. Callers that cannot
 * present images to the model (no vision capability) should NOT call this and
 * keep the existing note behavior.
 */
export function resolveTurnImageParts(
	attachments: AudioAttachment[],
): ResolveTurnImagesResult {
	const images: TurnImagePart[] = [];
	const fellBack: AudioAttachment[] = [];
	for (const attachment of attachments) {
		if (attachment.type === "audio") continue;
		const mime = normalizeMime(attachment.mimeType);
		const content = attachment.content ?? "";
		const isImageType =
			attachment.type === "image" || mime.startsWith("image/");
		if (!isImageType || !SUPPORTED_IMAGE_MIME.has(mime) || !content) {
			fellBack.push(attachment);
			continue;
		}
		if (images.length >= MAX_TURN_IMAGES) {
			fellBack.push(attachment);
			continue;
		}
		if (isUrlReference(content)) {
			// Already stored/hosted — reference it, do not inline (context budget).
			images.push({
				kind: "url",
				data: content,
				mediaType: mime,
				fileName: attachment.fileName,
			});
			continue;
		}
		if (base64ByteLength(content) > MAX_INLINE_IMAGE_BYTES) {
			fellBack.push(attachment);
			continue;
		}
		images.push({
			kind: "base64",
			data: content,
			mediaType: mime,
			fileName: attachment.fileName,
		});
	}
	return { images, fellBack };
}

/** Minimal env surface the helper needs. All Azure + gateway fields optional so
 * STT degrades to Workers AI (or fails soft) when they are absent. */
export interface VoiceSttEnv {
	/**
	 * Workers AI binding. Serves the `@cf/openai/whisper` fallback AND, for every
	 * provider listed in `AI_GATEWAY_BINDING_PROVIDERS`, the AI Gateway transport
	 * itself — see `@tedix/workers-ai/gateway-transport`.
	 */
	AI: Ai;
	AZURE_OPENAI_RESOURCE?: string;
	AZURE_OPENAI_STT_DEPLOYMENT?: string;
	AZURE_OPENAI_STT_API_VERSION?: string;
	AI_GATEWAY_ACCOUNT_ID?: string;
	AI_GATEWAY_LLM_ID?: string;
	/** Authenticated-gateway token -- cf-aig-authorization: Bearer <token>. */
	CF_AI_GATEWAY_TOKEN?: string;
	/**
	 * Comma-separated allowlist of AI Gateway provider segments served by an
	 * in-account gateway, which therefore ride the Workers AI binding instead of
	 * public HTTPS. Listing `azure-openai` routes Azure STT over the binding.
	 */
	AI_GATEWAY_BINDING_PROVIDERS?: string;
}

/** The audio attachment shape (subset of the contract attachment). */
export interface AudioAttachment {
	content: string; // base64
	fileName: string;
	mimeType: string;
	type: "audio" | "file" | "image";
}

export type SttProvider = "azure" | "workers-ai";

export interface TranscriptionResult {
	text: string;
	provider: SttProvider;
}

export type VoiceGatewayMetadata = Record<
	string,
	string | number | boolean | undefined
>;

function gatewayMetadata(
	channel: "voice-stt",
	metadata?: VoiceGatewayMetadata,
): Record<string, string | number | boolean> {
	return Object.fromEntries([
		["channel", channel],
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

const DEFAULT_AZURE_STT_DEPLOYMENT = "gpt-transcribe";
const DEFAULT_AZURE_STT_API_VERSION = "2025-01-01-preview";

/** Abort the Azure STT request after this long so a slow/unreachable endpoint
 * falls back to Workers AI whisper instead of hanging the whole chat turn. */
const AZURE_STT_TIMEOUT_MS = 20_000;

/** Audio mime types we recognise. Tedix OS sends the browser-native recording
 * container (webm/opus, ogg/opus, mp4) and plain audio uploads ride the same
 * path; the STT providers sniff the actual format. */
const SUPPORTED_AUDIO_MIME = new Set([
	"audio/wav",
	"audio/wave",
	"audio/x-wav",
	"audio/webm",
	"audio/ogg",
	"audio/mpeg",
	"audio/mp3",
	"audio/mp4",
	"audio/m4a",
	"audio/x-m4a",
	"audio/flac",
]);

export class SttError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SttError";
	}
}

/** True when authenticated AI Gateway BYOK can serve Azure STT. */
export function azureSttTransport(env: VoiceSttEnv): AiGatewayTransport | null {
	const gatewayId = env.AI_GATEWAY_LLM_ID?.trim();
	if (!env.AZURE_OPENAI_RESOURCE?.trim() || !gatewayId) return null;
	return resolveAiGatewayTransport(env, gatewayId, "azure-openai");
}

export function hasAzureStt(env: VoiceSttEnv): boolean {
	return azureSttTransport(env) !== null;
}

/** True when the shared LLM Gateway is available for Workers AI telemetry. */
export function hasAiGateway(env: VoiceSttEnv): boolean {
	return Boolean(env.AI_GATEWAY_ACCOUNT_ID && env.AI_GATEWAY_LLM_ID);
}

/** Decode base64 (with or without a `data:` URL prefix) to bytes. */
export function decodeBase64Audio(content: string): Uint8Array {
	const comma = content.indexOf(",");
	const raw =
		content.startsWith("data:") && comma !== -1
			? content.slice(comma + 1)
			: content;
	const bin = atob(raw);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}

/** Encode bytes without spreading a potentially multi-megabyte recording. */
export function encodeBase64Audio(bytes: Uint8Array): string {
	let binary = "";
	const chunkSize = 0x8000;
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		binary += String.fromCharCode(
			...bytes.subarray(offset, offset + chunkSize),
		);
	}
	return btoa(binary);
}

/** Validate that an attachment is audio we can transcribe, and within size. */
function validateAudioAttachment(attachment: AudioAttachment): Uint8Array {
	if (attachment.type !== "audio") {
		throw new SttError(`attachment is not audio (type=${attachment.type})`);
	}
	const mime = (
		(attachment.mimeType || "").toLowerCase().split(";")[0] ?? ""
	).trim();
	if (mime && !SUPPORTED_AUDIO_MIME.has(mime)) {
		// Don't hard-fail on an unknown but audio/* mime — providers may still
		// sniff it. Only reject obviously non-audio types.
		if (!mime.startsWith("audio/")) {
			throw new SttError(`unsupported audio mime type: ${mime}`);
		}
	}
	let bytes: Uint8Array;
	try {
		bytes = decodeBase64Audio(attachment.content);
	} catch {
		throw new SttError("attachment content is not valid base64");
	}
	if (bytes.length === 0) {
		throw new SttError("attachment audio is empty");
	}
	if (bytes.length > MAX_AUDIO_BYTES) {
		throw new SttError(
			`audio too large (${bytes.length} bytes > ${MAX_AUDIO_BYTES})`,
		);
	}
	return bytes;
}

/**
 * Build the gateway-only Azure transcription URL.
 */
function azureTranscriptionUrl(
	env: VoiceSttEnv,
	transport: AiGatewayTransport,
): string {
	const resource = env.AZURE_OPENAI_RESOURCE as string;
	const deployment =
		env.AZURE_OPENAI_STT_DEPLOYMENT ?? DEFAULT_AZURE_STT_DEPLOYMENT;
	const apiVersion =
		env.AZURE_OPENAI_STT_API_VERSION ?? DEFAULT_AZURE_STT_API_VERSION;
	const query = `?api-version=${encodeURIComponent(apiVersion)}`;
	return `${transport.providerRoot}/${resource}/${deployment}/audio/transcriptions${query}`;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const out = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(out).set(bytes);
	return out;
}

async function transcribeAzure(
	env: VoiceSttEnv,
	bytes: Uint8Array,
	attachment: AudioAttachment,
	metadata?: VoiceGatewayMetadata,
	language?: string,
): Promise<string> {
	const transport = azureSttTransport(env);
	if (!transport) {
		throw new SttError("Azure STT requires authenticated AI Gateway BYOK");
	}
	const url = azureTranscriptionUrl(env, transport);
	const form = new FormData();
	const fileName = attachment.fileName || "audio.wav";
	form.append(
		"file",
		new Blob([toArrayBuffer(bytes)], {
			type: attachment.mimeType || "audio/wav",
		}),
		fileName,
	);
	const languageHint = /^[a-z]{2,3}$/i.test(language ?? "") ? language : null;
	if (languageHint) form.append("language", languageHint);
	form.append(
		"model",
		env.AZURE_OPENAI_STT_DEPLOYMENT ?? DEFAULT_AZURE_STT_DEPLOYMENT,
	);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), AZURE_STT_TIMEOUT_MS);
	let res: Response;
	try {
		const headers: Record<string, string> = {
			// On the binding transport this is the pre-authenticated sentinel.
			"cf-aig-authorization": `Bearer ${transport.authorization}`,
			"cf-aig-metadata": JSON.stringify(gatewayMetadata("voice-stt", metadata)),
		};
		res = await transport.fetch(url, {
			method: "POST",
			headers,
			body: form,
			signal: controller.signal,
		});
	} catch (err) {
		if (controller.signal.aborted) {
			throw new SttError(`Azure STT timed out after ${AZURE_STT_TIMEOUT_MS}ms`);
		}
		throw new SttError(
			`Azure STT request failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	} finally {
		clearTimeout(timer);
	}
	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		throw new SttError(
			`Azure STT failed (${res.status})${detail ? `: ${detail.slice(0, 300)}` : ""}`,
		);
	}
	const json = (await res.json()) as { text?: unknown };
	if (typeof json.text !== "string") {
		throw new SttError("Azure STT returned no transcript text");
	}
	return json.text;
}

async function transcribeWorkersAi(
	env: VoiceSttEnv,
	bytes: Uint8Array,
	metadata?: VoiceGatewayMetadata,
): Promise<string> {
	// `@cf/openai/whisper` wants an int array of the raw audio bytes.
	const audio: number[] = Array.from(bytes);
	// AI Gateway for Workers AI rides the binding's `gateway` option.
	const options = hasAiGateway(env)
		? {
				gateway: {
					id: env.AI_GATEWAY_LLM_ID as string,
					metadata: gatewayMetadata("voice-stt", metadata),
				},
			}
		: undefined;
	const out = (await env.AI.run("@cf/openai/whisper", { audio }, options)) as {
		text?: unknown;
	};
	if (typeof out.text !== "string") {
		throw new SttError("Workers AI whisper returned no transcript text");
	}
	return out.text;
}

/**
 * Transcribe a single audio attachment to text. Azure is preferred when its
 * creds exist; on an Azure error/timeout we FALL BACK to Workers AI whisper at
 * runtime rather than letting a slow/broken Azure endpoint sink the
 * voice note — `env.AI` is always present, so whisper is always reachable.
 * Throws {@link SttError} only when BOTH providers fail (or validation fails) —
 * callers fail soft (dispatch the turn with a clear "[audio transcription
 * failed]" note rather than dropping the message).
 */
export async function transcribeAudioAttachment(
	env: VoiceSttEnv,
	attachment: AudioAttachment,
	options?: { gatewayMetadata?: VoiceGatewayMetadata; language?: string },
): Promise<TranscriptionResult> {
	const bytes = validateAudioAttachment(attachment);
	if (hasAzureStt(env)) {
		try {
			const text = await transcribeAzure(
				env,
				bytes,
				attachment,
				options?.gatewayMetadata,
				options?.language,
			);
			return { text: text.trim(), provider: "azure" };
		} catch (azureErr) {
			const reason =
				azureErr instanceof Error ? azureErr.message : String(azureErr);
			console.warn(
				`[voice-stt] Azure STT failed, falling back to Workers AI whisper: ${reason}`,
			);
		}
	}
	const text = await transcribeWorkersAi(env, bytes, options?.gatewayMetadata);
	return { text: text.trim(), provider: "workers-ai" };
}

/**
 * Mirror the runtime transcript convention: inject the
 * transcript into the chat turn, keeping any user-typed text. Returns the
 * content the isolate turn should run with.
 */
export function buildTranscriptContent(
	userText: string,
	transcript: string,
): string {
	const trimmedUser = userText.trim();
	const trimmedTranscript = transcript.trim();
	// Distinguish a SUCCESSFUL-but-silent transcription from a FAILURE: the
	// failed path uses buildFailedTranscriptContent("[audio transcription
	// failed: …]"), so an empty success here means STT ran and heard no speech.
	const block = `[Voice message transcript]\n${trimmedTranscript || "(no speech detected)"}`;
	if (!trimmedUser) return block;
	return `${trimmedUser}\n\n${block}`;
}

/** Fail-soft content used when transcription throws. Keeps the turn alive. */
export function buildFailedTranscriptContent(
	userText: string,
	reason: string,
): string {
	const trimmedUser = userText.trim();
	const note = `[audio transcription failed: ${reason}]`;
	if (!trimmedUser) return note;
	return `${trimmedUser}\n\n${note}`;
}

export interface VoiceTranscriptMetadata {
	transcript: string;
	provider: SttProvider;
	fileName: string;
	mimeType: string;
}

export interface VoiceMessageResolution {
	content: string;
	voiceTranscript: VoiceTranscriptMetadata | null;
}

export type VoiceAttachmentTranscriber = typeof transcribeAudioAttachment;

export interface ResolveVoiceMessageContentInput {
	env: VoiceSttEnv;
	content: string;
	attachments?: AudioAttachment[];
	logContext?: string;
	transcribe?: VoiceAttachmentTranscriber;
	includeNonAudioAttachmentNote?: boolean;
	warn?: (message: string, reason: string) => void;
	/**
	 * Opt-in (FAIL-SOFT): resolve image attachments into model-facing image
	 * parts (see {@link resolveTurnImageParts}). Callers MUST only set this when
	 * the turn's model is vision-capable. Images that become parts are dropped
	 * from the filename note (they reach the model directly); everything else —
	 * non-image files, oversized/over-count/unsupported images — still rides the
	 * existing note. When false/unset, behavior is byte-for-byte unchanged.
	 */
	resolveImages?: boolean;
	/** Flat primitive Gateway metadata, capped with `channel` to five entries. */
	gatewayMetadata?: VoiceGatewayMetadata;
}

function buildNonAudioAttachmentNote(
	attachments: AudioAttachment[],
): string | null {
	const nonAudio = attachments.filter(
		(attachment) => attachment.type !== "audio",
	);
	if (nonAudio.length === 0) return null;
	const list = nonAudio
		.map((attachment) => `- ${attachment.fileName} (${attachment.mimeType})`)
		.join("\n");
	return `[Attachments received (not yet processed by this tedi):\n${list}]`;
}

export interface VoiceMessageImageResolution extends VoiceMessageResolution {
	/** Image content parts to attach to the model turn (empty when the caller
	 * did not opt in to image resolution, or every image fell back to a note).
	 * Callers map these to their model client's image-part shape. */
	images: TurnImagePart[];
}

/**
 * Resolve the model-facing text for an async voice message. The raw attachment
 * remains available to callers for ledgers/body-specific media handling; this
 * helper only standardizes the transcript text and optional metadata.
 */
export async function resolveVoiceMessageContent(
	input: ResolveVoiceMessageContentInput,
): Promise<VoiceMessageImageResolution> {
	const attachments = input.attachments ?? [];
	let content = input.content;
	let voiceTranscript: VoiceTranscriptMetadata | null = null;

	const audioAttachment = attachments.find(
		(attachment) => attachment.type === "audio",
	);
	if (audioAttachment) {
		try {
			const result = await (input.transcribe ?? transcribeAudioAttachment)(
				input.env,
				audioAttachment,
				{ gatewayMetadata: input.gatewayMetadata },
			);
			content = buildTranscriptContent(content, result.text);
			voiceTranscript = {
				transcript: result.text,
				provider: result.provider,
				fileName: audioAttachment.fileName,
				mimeType: audioAttachment.mimeType,
			};
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			const message = input.logContext
				? `[${input.logContext}] voice-note transcription failed:`
				: "[voice-stt] voice-note transcription failed:";
			if (input.warn) {
				input.warn(message, reason);
			} else {
				console.warn(message, reason);
			}
			content = buildFailedTranscriptContent(content, reason);
		}
	}

	// FAIL-SOFT image resolution: when the caller opts in (vision-capable
	// model), image attachments become model-facing image parts and are
	// dropped from the filename note. Everything that fell back — non-image
	// files, oversized / over-count / unsupported images — still rides the
	// note so nothing is silently dropped. When `resolveImages` is unset, the
	// note covers every non-audio attachment exactly as before.
	let images: TurnImagePart[] = [];
	let noteAttachments = attachments;
	if (input.resolveImages) {
		const resolved = resolveTurnImageParts(attachments);
		images = resolved.images;
		// Keep audio out of the note (the STT path owns it) and list only the
		// attachments that did not become image parts.
		noteAttachments = resolved.fellBack;
	}

	if (input.includeNonAudioAttachmentNote) {
		const note = buildNonAudioAttachmentNote(noteAttachments);
		if (note) content = content.trim() ? `${content}\n\n${note}` : note;
	}

	return { content, voiceTranscript, images };
}
