/**
 * apps/tedi-runtime — `VoiceInputDO`: TRANSCRIPTION-ONLY DICTATION for isolate tedis.
 *
 * ============================ ARCHITECTURE ============================
 * A sibling Durable Object that does STT-only — NO TTS, NO LLM consult.
 * The browser streams PCM16 over a WebSocket and receives transcript events
 * back. Designed for Tedix OS's composer dictation widget.
 *
 * `VoiceInputDO` holds ZERO canonical state. There is no tedi consult, no
 * cognitive ledger touch, no recap on call end. The durable record of what
 * was said lives wherever the Tedix OS composer writes it.
 *
 * ============================ DATA FLOW ============================
 *   browser ──WS──▶ /voice/input?slug=…  (edge: index.ts, auth mirrors /voice/call)
 *                      │  idFromName(`${slug}:input`)
 *                      ▼
 *                 VoiceInputDO  (this file — withVoiceInput(Agent))
 *                      │  onTranscript → #vlog only (mixin auto-sends frames)
 *                      ▼  (no AgentTediDO consult — dictation is terminal here)
 *
 * ============================ WIRE PROTOCOL ============================
 * Binary frames:  PCM16, 16 kHz, mono, little-endian. Raw ArrayBuffer chunks
 *                 sent continuously after start_call; no framing/header.
 *
 * Client→Server JSON:
 *   { type: "hello", protocol_version?: number }    — optional greeting
 *   { type: "start_call" }                          — begin STT session
 *   { type: "end_call" }                            — end STT session
 *   { type: "interrupt" }                           — abort current utterance
 *   { type: "start_of_speech" }                     — advisory (no effect here)
 *   { type: "end_of_speech" }                       — advisory (no effect here)
 *
 * Server→Client JSON (all sent by the mixin automatically):
 *   { type: "welcome", protocol_version: 1 }        — on connect
 *   { type: "status", status: "idle" }              — on connect and after end_call
 *   { type: "status", status: "listening" }         — after start_call
 *   { type: "transcript_interim", text: string }    — unstable partial (Nova 3 non-final)
 *   { type: "transcript_interim", text: "" }        — clears interim before final
 *   { type: "transcript", role: "user", text: string } — stable final utterance
 *   { type: "error", message: string }              — transcriber missing or crashed
 *
 * No binary frames are ever sent from server to client (STT-only, no TTS).
 *
 * @experimental Built on `@cloudflare/voice@0.3.6` (pinned exactly via the root
 * catalog).
 */

import {
	type Transcriber,
	WorkersAIFluxSTT,
	withVoiceInput,
} from "@cloudflare/voice";
import type { RecordVoiceProviderUsageInput } from "@tedix/api-contract/schemas/billing";
import {
	createInstrumentedVoiceTranscriber,
	installVoiceWireGuard,
	SingleSpeakerGate,
} from "@tedix/voice/runtime";
import { Agent, type Connection, type ConnectionContext } from "agents";

import { recordVoiceProviderUsage } from "./voice-provider-usage-client";
import {
	logTediVoiceEvent,
	logTediVoiceFailure,
	logTediVoiceTelemetry,
} from "./voice-log";

interface VoiceInputContext {
	slug: string;
	tediId: string;
	organizationId: string;
	callId: string;
	connectedAt: number;
	providerStartedAt?: number;
	sttRecorded?: boolean;
}

/** Minimal Workers AI surface the STT providers call (`.run(model, input, options)`). */
type AiRunner = {
	run(
		model: string,
		input: Record<string, unknown>,
		options?: Record<string, unknown>,
	): Promise<unknown>;
};

const VoiceInputBase = withVoiceInput(Agent<Cloudflare.Env>);

export class VoiceInputDO extends VoiceInputBase {
	/**
	 * `hibernate: false` required — the STT session holds an open
	 * Workers AI WebSocket for the full call duration. Hibernation would
	 * destroy that session mid-dictation.
	 * `sendIdentityOnConnect: false` avoids leaking the DO name to the browser.
	 */
	static options = { hibernate: false, sendIdentityOnConnect: false };

	// Flux is the currently proven Workers AI streaming provider. Nova-3
	// returns stt_startup_failed before accepting PCM in production.
	transcriber = ((): Transcriber => {
		return new WorkersAIFluxSTT(this.rawAi(), { eotTimeoutMs: 3000 });
	})();

	/**
	 * Instrumented transcriber wrapper (mirrors `VoiceCallDO.createTranscriber`):
	 * proves whether PCM reaches the STT session (`stt.feed`) and whether the
	 * provider emits anything (`stt.interim` / `stt.utterance`) — the Nova-3
	 * silent-session failure mode is invisible without this.
	 *
	 * Composition (inner → outer):
	 *   WorkersAINova3STT  (raw Workers AI session — manages the outbound WS)
	 *     → SelfHealingSession  (watchdog + rolling buffer + reconnect on stall)
	 *         → logging wrapper below  (stt.feed / stt.interim / stt.utterance)
	 */
	override createTranscriber(connection: Connection): Transcriber | null {
		return createInstrumentedVoiceTranscriber({
			base: this.transcriber,
			fields: () => ({
				conn: connection.id,
				slug: this.#ctxByConn.get(connection.id)?.slug ?? "unknown",
			}),
			log: (event, fields) => this.#vlog(event, fields),
		});
	}

	/**
	 * Single-active-session enforcement: tracks the connection.id of the
	 * currently active dictation session. A second connection into the same
	 * `VoiceInputDO` instance (keyed `${slug}:input`) is rejected in
	 * `beforeCallStart` until the first caller ends or disconnects.
	 * Cleared in both `onCallEnd` (explicit end_call) and `onClose` (socket
	 * drop without end_call) — a crashed tab never deadlocks the DO.
	 */
	#speakerGate = new SingleSpeakerGate();

	/**
	 * Provider attribution captured from the authenticated WS upgrade.
	 */
	#ctxByConn = new Map<string, VoiceInputContext>();

	/**
	 * Outermost `onMessage` wrap: Blob→ArrayBuffer normalization.
	 *
	 * WHY: workerd delivers binary frames on non-hibernating WebSockets as
	 * **Blob** (WHATWG `binaryType: "blob"` default), but `withVoiceInput`'s
	 * mixin only checks `message instanceof ArrayBuffer` — Blobs fall through
	 * `#cm.bufferAudio`, so STT never receives audio. This is the SAME bug
	 * fixed in `VoiceCallDO`. `onConnect` also sets `binaryType = "arraybuffer"`
	 * as the primary fix; this branch is the belt-and-braces fallback.
	 * Conversions are chained on one promise so PCM frame ORDER is preserved.
	 */
	constructor(...args: ConstructorParameters<typeof VoiceInputBase>) {
		super(...args);
		installVoiceWireGuard(this, {
			log: (event, fields) => this.#vlog(event, fields),
		});
	}

	/**
	 * Capture the slug + set binaryType. The mixin sends `welcome` + `idle`
	 * first (it wraps onConnect in its constructor), then chains to this.
	 */
	override async onConnect(
		connection: Connection,
		ctx: ConnectionContext,
	): Promise<void> {
		// Primary fix for Blob-framed audio — force ArrayBuffer delivery on the
		// accepted socket so PCM frames hit the mixin's `instanceof ArrayBuffer`
		// branch synchronously, in order.
		try {
			(connection as { binaryType?: string }).binaryType = "arraybuffer";
		} catch {
			// older runtimes without a settable binaryType — Blob fallback covers it
		}
		try {
			const url = new URL(ctx.request.url);
			const slug =
				url.searchParams.get("slug") ?? this.name?.split(":")[0] ?? "unknown";
			const tediId =
				url.searchParams.get("tedi") ??
				ctx.request.headers.get("X-Tedi-Id") ??
				slug;
			const organizationId =
				url.searchParams.get("organization") ??
				ctx.request.headers.get("X-Tedi-Org-Id") ??
				"";
			this.#ctxByConn.set(connection.id, {
				slug,
				tediId,
				organizationId,
				callId: `voice-input-${this.name}-${connection.id}-${Date.now()}`,
				connectedAt: Date.now(),
			});
			this.#vlog("connect", { conn: connection.id, slug });
		} catch (err) {
			logTediVoiceFailure(
				"voice-input",
				"voice.input_context_capture_failed",
				err,
			);
		}
		await super.onConnect(connection, ctx);
	}

	/**
	 * Single-session enforcement via the `beforeCallStart` hook exposed by the
	 * `withVoiceInput` mixin. Returns false to reject the call (mixin will
	 * call `#cm.cleanup` and NOT send `status: "listening"`). Returns true to
	 * admit and lock the speaker slot.
	 *
	 * The mixin calls this hook AFTER `#cm.initConnection` (the connection is
	 * registered) but BEFORE the transcriber session is created — so rejecting
	 * here leaves no dangling STT WebSocket.
	 */
	override beforeCallStart(connection: Connection): boolean {
		const slug = this.#ctxByConn.get(connection.id)?.slug ?? "unknown";
		const claimed = this.#speakerGate.tryClaim(connection, {
			fields: () => ({ conn: connection.id, slug }),
			log: (event, fields) => this.#vlog(event, fields),
		});
		if (!claimed) return false;
		this.#vlog("call.start", { conn: connection.id, slug });
		return true;
	}

	/**
	 * Called by the mixin after each stable final utterance has been sent to
	 * the client. We only log here — the mixin already sends the transcript
	 * frames automatically before calling this hook:
	 *   1. `{ type: "transcript_interim", text: "" }` — clears the interim
	 *   2. `{ type: "transcript", role: "user", text }` — the final utterance
	 * No manual send is needed.
	 */
	override onTranscript(text: string, connection: Connection): void {
		const slug = this.#ctxByConn.get(connection.id)?.slug ?? "unknown";
		this.#vlog("transcript", {
			conn: connection.id,
			slug,
			chars: text.length,
		});
	}

	/**
	 * Hook called when the mixin's `start_call` handler completes and the STT
	 * session is live.
	 */
	override onCallStart(connection: Connection): void {
		const context = this.#ctxByConn.get(connection.id);
		if (context) context.providerStartedAt = Date.now();
		const slug = context?.slug ?? "unknown";
		this.#vlog("stt.session.live", { conn: connection.id, slug });
	}

	async #recordVoiceUsage(input: RecordVoiceProviderUsageInput): Promise<void> {
		await recordVoiceProviderUsage(this.env, input);
	}

	async #recordSttUsage(
		ctx: VoiceInputContext,
		endedAt: number,
	): Promise<void> {
		if (!ctx.providerStartedAt || ctx.sttRecorded) return;
		ctx.sttRecorded = true;
		if (!ctx.organizationId) {
			logTediVoiceEvent("voice-input", "voice.input_usage_org_missing");
			return;
		}
		await this.#recordVoiceUsage({
			organizationId: ctx.organizationId,
			tediId: ctx.tediId,
			providerUsageId: `workers-ai:voice-stt:${ctx.callId}`,
			provider: "workers-ai",
			model: "@cf/deepgram/flux",
			usageKind: "voice_stt",
			unit: "seconds",
			quantity: Math.max(
				1,
				Math.ceil((endedAt - ctx.providerStartedAt) / 1000),
			),
			occurredAt: new Date(endedAt).toISOString(),
			metadata: { callId: ctx.callId, channel: "voice-input" },
		});
	}

	/**
	 * Hook called on explicit `end_call`. Clear the speaker slot.
	 */
	override async onCallEnd(connection: Connection): Promise<void> {
		this.#speakerGate.release(connection);
		const context = this.#ctxByConn.get(connection.id);
		if (context) await this.#recordSttUsage(context, Date.now());
		const slug = context?.slug ?? "unknown";
		this.#vlog("call.end", { conn: connection.id, slug });
		this.#ctxByConn.delete(connection.id);
	}

	/**
	 * Socket-close safety net — mirrors `VoiceCallDO.onClose`.
	 *
	 * The mixin's onClose chain calls `#cm.cleanup` + `#releaseKeepAlive` but
	 * does NOT call `#handleEndCall`, so `onCallEnd` is never invoked on a
	 * crash-closed tab. Clearing the speaker gate here prevents the DO
	 * from being permanently locked to a dead connection.
	 */
	override onClose(connection: Connection, ...rest: unknown[]): void {
		const context = this.#ctxByConn.get(connection.id);
		if (this.#speakerGate.release(connection)) {
			this.#vlog("call.speaker_slot_cleared", {
				conn: connection.id,
				reason: "socket_close",
			});
		}
		if (context) this.ctx.waitUntil(this.#recordSttUsage(context, Date.now()));
		this.#ctxByConn.delete(connection.id);
		(super.onClose as ((...args: unknown[]) => unknown) | undefined)?.(
			connection,
			...rest,
		);
	}

	/** Low-frequency voice diagnostics without speech text in any environment. */
	#vlog(event: string, fields?: Record<string, unknown>): void {
		logTediVoiceTelemetry("voice-input", event, fields);
	}

	/**
	 * Raw AI binding — required for Nova 3's WebSocket STT session.
	 * AI Gateway does not proxy WebSocket connections so we bypass it here.
	 */
	private rawAi(): AiRunner {
		const ai = (this.env as { AI?: AiRunner }).AI;
		if (!ai) {
			throw new Error("[VoiceInputDO] AI binding unavailable");
		}
		return ai;
	}
}
