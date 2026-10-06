/**
 * apps/tedi-runtime — `VoiceCallDO`: LIVE BROWSER VOICE CALLS for isolate tedis.
 *
 * ============================ ARCHITECTURE ============================
 * This is a SIBLING Durable Object, deliberately NOT `withVoice(AgentTediDO)`.
 *
 * Voice has a separate WebSocket lifecycle from native Pi chat.
 * `@cloudflare/voice` wraps `onMessage` in its constructor, so browser voice
 * lives in its OWN DO whose `onTurn` CONSULTS the canonical tedi loop via RPC.
 *
 * `VoiceCallDO` holds ZERO canonical state. The voice package persists call
 * scratch to a `cf_voice_messages` SQLite table — that is EPHEMERAL, used only
 * to drive the live call. Spoken user/assistant turns land in the canonical
 * session through `streamChatTurn({ origin: "voice" })`; the call-end recap is
 * additive summary, not the only durable memory.
 *
 * ============================ DATA FLOW ============================
 *   browser ──WS──▶ /voice/call?slug=…  (edge: index.ts, auth mirrors /acp)
 *                      │  idFromName(`${slug}:${conversationKey}`)
 *                      ▼
 *                 VoiceCallDO  (this file — withVoice(Agent), Deepgram via AI)
 *                      │  onTurn(transcript) → consult({mode:"turn"})
 *                      │  onCallEnd()        → consult({mode:"recap"})
 *                      ▼  TEDI_AGENT.idFromName(isolateAgentId)
 *                 AgentTediDO  /__internal/voice/consult
 *                      │  streamChatTurn(SAME conversationId as Tedix OS chat)
 *                      ▼  → ledger / brain / session / MCP tools (for free)
 *
 * @experimental Built on `@cloudflare/voice@0.3.6` (pinned exactly via the root
 * catalog — the SDK is not yet stable).
 */

import {
	type Transcriber,
	type VoiceTurnContext,
	WorkersAIFluxSTT,
	WorkersAITTS,
	withVoice,
} from "@cloudflare/voice";
import type { RecordVoiceProviderUsageInput } from "@tedix/api-contract/schemas/billing";
import { DEFAULT_SESSION_KEY } from "@tedix/tedi-session/session-harness";
import {
	createInstrumentedVoiceTranscriber,
	filterVoiceUtterance,
	installVoiceWireGuard,
	SingleSpeakerGate,
} from "@tedix/voice/runtime";
import { Agent, type Connection, type ConnectionContext } from "agents";
import { recordVoiceProviderUsage } from "./voice-provider-usage-client";
import { buildVoiceCallRecap, type VoiceRecapTurn } from "./voice-recap";
import {
	logTediVoiceEvent,
	logTediVoiceFailure,
	logTediVoiceTelemetry,
	voiceErrorRetryable,
} from "./voice-log";

/**
 * Per-call context captured from the WS upgrade URL at connect time. The edge
 * (`index.ts`) stamps the resolved tedi's `isolateAgentId` + `slug` on the
 * `/voice/call` URL so the VoiceCallDO can address the canonical AgentTediDO
 * via `TEDI_AGENT.idFromName(isolateAgentId)` WITHOUT a second D1 lookup.
 */
interface VoiceCallContext {
	slug: string;
	isolateAgentId: string;
	tediId: string;
	organizationId: string;
	sessionKey: string;
	/** Stable per-call id for runId derivation on the canonical side. */
	callId: string;
	startedAt: number;
	providerStartedAt?: number;
	sttRecorded?: boolean;
	ttsCount: number;
}

/** Minimal Workers AI surface the voice providers call (`.run(model, input, options)`). */
type AiRunner = {
	aiGatewayLogId?: string;
	run(
		model: string,
		input: Record<string, unknown>,
		options?: Record<string, unknown>,
	): Promise<unknown>;
};

/**
 * Key under which the per-call routing context is stored in the connection's
 * hibernation-safe state (`connection.setState`). Namespaced so it coexists with
 * any state the voice mixin / Agents SDK keeps on the same connection.
 */
const VOICE_CTX_STATE_KEY = "tedixVoiceCtx";

const VoiceAgentBase = withVoice(Agent<Cloudflare.Env>);

export class VoiceCallDO extends VoiceAgentBase {
	/**
	 * `hibernate: false` is required for production voice agents: the package's
	 * keepAlive timer is best-effort, while the live browser call holds a realtime
	 * STT WebSocket. `sendIdentityOnConnect: false` avoids exposing the DO name to
	 * the browser; the voice client does not need it.
	 */
	static options = { hibernate: false, sendIdentityOnConnect: false };

	// Flux STT is a realtime bidirectional WebSocket. The official package docs
	// construct it with the raw AI binding, so keep it off the AI Gateway wrapper.
	// Aura TTS is request/response and can stay gateway-routed for observability.
	//
	// End-of-turn tuning for NOISY environments: background noise keeps Flux's
	// turn-confidence low, so with the default 5000ms timeout a turn can hang
	// un-finalized while the operator waits for an answer. Bound the wait at 3s
	// so a pause is always answered. The confidence threshold stays at the 0.7
	// default — field testing showed mid-sentence pauses ("Can you …") already
	// finalize eagerly, so lowering it would trade one failure for another.
	// The client-side mute control (streams silence) is the manual override
	// for the worst rooms.
	transcriber = new WorkersAIFluxSTT(this.rawAi(), {
		eotTimeoutMs: 3000,
	});
	tts = new WorkersAITTS(this.gatewayAi());

	/**
	 * Per-connection call context. One VoiceCallDO instance is keyed
	 * `${slug}:${conversationKey}`, so in practice it serves one logical call
	 * target, but we key by connection id to stay correct if a client reconnects.
	 */
	#ctxByConn = new Map<string, VoiceCallContext>();
	#activeConnectionId: string | null = null;
	#activeContext: VoiceCallContext | null = null;

	/**
	 * Single-speaker enforcement: tracks the connection.id of the currently
	 * active speaker. A second browser tab opening a call into the SAME
	 * VoiceCallDO instance (keyed `${slug}:${conversationKey}`) is rejected in
	 * `beforeCallStart` until the first speaker's call ends. Cleared in
	 * `onCallEnd` (explicit end_call) AND in `onClose` (socket drop without
	 * end_call) so a crashed tab never deadlocks the DO.
	 */
	#speakerGate = new SingleSpeakerGate();

	/**
	 * Outermost `onMessage` wrap: Blob→ArrayBuffer normalization + wire-level
	 * diagnostics. Both `agents`' Agent and `withVoice` install `onMessage` as an
	 * OWN property in their constructors (Agent first, voice mixin on top);
	 * installing here — after super() — wraps outermost, so every frame is
	 * observed/normalized BEFORE any SDK routing.
	 *
	 * Why the normalization exists (root cause of "the agent never responds"):
	 * workerd delivers binary frames on non-hibernating WebSockets as **Blob**
	 * (the WHATWG `binaryType: "blob"` default), but `@cloudflare/voice`'s
	 * wrapper only checks `message instanceof ArrayBuffer` — Blobs fell through
	 * past `bufferAudio`, so STT never received a single byte and no turn ever
	 * fired. `onConnect` also sets `binaryType = "arraybuffer"` on the socket;
	 * this branch is the belt-and-braces fallback. Conversions are chained on
	 * one promise so PCM frame ORDER is preserved for the transcriber.
	 */
	constructor(...args: ConstructorParameters<typeof VoiceAgentBase>) {
		super(...args);
		installVoiceWireGuard(this, {
			log: (event, fields) => this.#vlog(event, fields),
		});
	}

	/**
	 * Persist the per-call routing context BOTH in-memory and on the connection's
	 * state. The state path survives hibernation/reload; the Map covers the common
	 * same-instance path.
	 */
	#persistCtx(connection: Connection, callCtx: VoiceCallContext): void {
		this.#ctxByConn.set(connection.id, callCtx);
		try {
			const conn = connection as {
				state?: unknown;
				setState?: (state: unknown) => unknown;
			};
			if (typeof conn.setState === "function") {
				const existing =
					conn.state && typeof conn.state === "object"
						? (conn.state as Record<string, unknown>)
						: {};
				conn.setState({ ...existing, [VOICE_CTX_STATE_KEY]: callCtx });
			}
		} catch (err) {
			logTediVoiceFailure("voice-call", "voice.context_persist_failed", err);
		}
	}

	#getCtx(connection: Connection): VoiceCallContext | undefined {
		const cached = this.#ctxByConn.get(connection.id);
		if (cached) return cached;
		const state =
			(connection as { state?: unknown }).state &&
			typeof (connection as { state?: unknown }).state === "object"
				? ((connection as { state?: unknown }).state as Record<string, unknown>)
				: undefined;
		const persisted = state?.[VOICE_CTX_STATE_KEY] as
			| VoiceCallContext
			| undefined;
		if (persisted) {
			this.#ctxByConn.set(connection.id, persisted);
			return persisted;
		}
		return undefined;
	}

	/**
	 * Low-frequency voice diagnostics. Logs omit speech text but keep
	 * event names, counts, sizes, and latency so we can tell whether a call reached
	 * the DO, whether PCM reached STT, and whether Flux emitted an utterance.
	 */
	#vlog(event: string, fields?: Record<string, unknown>): void {
		logTediVoiceTelemetry("voice-call", event, fields);
	}

	/**
	 * Raw AI binding. Use this for realtime Flux STT because the package opens a
	 * Workers AI websocket (`ai.run(..., { websocket: true })`).
	 */
	private rawAi(): AiRunner {
		const ai = (this.env as { AI?: AiRunner }).AI;
		if (!ai) {
			throw new Error("[VoiceCallDO] AI binding unavailable");
		}
		return ai;
	}

	/**
	 * AI Gateway wrapper for request/response providers such as TTS.
	 */
	private gatewayAi(): AiRunner {
		const ai = this.rawAi();
		const gatewayId = (this.env as { AI_GATEWAY_LLM_ID?: string })
			.AI_GATEWAY_LLM_ID;
		return {
			run: async (model, input, options) => {
				const text = typeof input.text === "string" ? input.text : "";
				const callCtx = this.#activeContext;
				const priorGatewayLogId = ai.aiGatewayLogId?.trim() || null;
				const existingGateway = (
					options as { gateway?: Record<string, unknown> } | undefined
				)?.gateway;
				const result = await ai.run(
					model,
					input,
					gatewayId
						? {
								...options,
								gateway: {
									...existingGateway,
									id: gatewayId,
									metadata: {
										channel: "voice-tts",
										orgId: this.#activeContext?.organizationId,
										tediId: this.#activeContext?.tediId,
										usage: JSON.stringify({
											k: "voice_tts",
											u: "characters",
											q: Math.max(1, text.length),
										}),
									},
								},
							}
						: options,
				);
				if (callCtx && (!(result instanceof Response) || result.ok)) {
					callCtx.ttsCount += 1;
					this.ctx.waitUntil(
						this.#recordVoiceUsage({
							organizationId: callCtx.organizationId,
							tediId: callCtx.tediId,
							providerUsageId: `workers-ai:voice-tts:${callCtx.callId}:${callCtx.ttsCount}`,
							gatewayLogId:
								ai.aiGatewayLogId?.trim() &&
								ai.aiGatewayLogId.trim() !== priorGatewayLogId
									? ai.aiGatewayLogId.trim()
									: null,
							provider: "workers-ai",
							model,
							usageKind: "voice_tts",
							unit: "characters",
							quantity: Math.max(1, text.length),
							occurredAt: new Date().toISOString(),
							metadata: {
								callId: callCtx.callId,
								channel: "voice-tts",
								sequence: callCtx.ttsCount,
							},
						}),
					);
				}
				return result;
			},
		};
	}

	async #recordVoiceUsage(input: RecordVoiceProviderUsageInput): Promise<void> {
		await recordVoiceProviderUsage(this.env, input);
	}

	async #recordSttUsage(ctx: VoiceCallContext, endedAt: number): Promise<void> {
		if (!ctx.providerStartedAt || ctx.sttRecorded) return;
		ctx.sttRecorded = true;
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
			metadata: { callId: ctx.callId, channel: "voice-stt" },
		});
	}

	/**
	 * Wrap the configured transcriber so production can prove whether browser PCM
	 * reaches Flux. This does not alter audio or transcript callbacks.
	 *
	 * Composition (inner → outer):
	 *   WorkersAIFluxSTT  (raw Flux session — manages the outbound WS)
	 *     → SelfHealingSession  (watchdog + rolling buffer + reconnect on stall)
	 *         → logging wrapper below  (stt.feed / stt.interim / stt.utterance)
	 *
	 * Heal logs arrive through the DO's #vlog so they appear alongside the
	 * existing STT telemetry in the same log stream.
	 */
	override createTranscriber(connection: Connection): Transcriber | null {
		return createInstrumentedVoiceTranscriber({
			base: this.transcriber,
			fields: () => ({
				conn: connection.id,
				slug: this.#getCtx(connection)?.slug,
			}),
			log: (event, fields) => this.#vlog(event, fields),
		});
	}

	/**
	 * Capture the per-call context from the WS upgrade URL. The voice mixin sends
	 * `welcome` + `idle` first (it wrapped `onConnect` in its constructor), then
	 * chains to THIS override. We read `slug`, `agent` (isolateAgentId), and
	 * `conversation` (sessionKey) query params the edge stamped.
	 */
	override async onConnect(
		connection: Connection,
		ctx: ConnectionContext,
	): Promise<void> {
		// Primary fix for Blob-framed audio (see constructor): force ArrayBuffer
		// delivery on the accepted socket so PCM frames hit the voice mixin's
		// `instanceof ArrayBuffer` branch synchronously, in order.
		try {
			(connection as { binaryType?: string }).binaryType = "arraybuffer";
		} catch {
			// older runtimes without a settable binaryType — Blob fallback covers it
		}
		try {
			const url = new URL(ctx.request.url);
			const slug = url.searchParams.get("slug") ?? this.callSlugFromName();
			const isolateAgentId =
				url.searchParams.get("agent") ??
				url.searchParams.get("isolateAgentId") ??
				slug;
			const tediId =
				url.searchParams.get("tedi") ??
				ctx.request.headers.get("X-Tedi-Id") ??
				slug;
			const organizationId =
				url.searchParams.get("organization") ??
				ctx.request.headers.get("X-Tedi-Org-Id") ??
				"";
			const sessionKey =
				url.searchParams.get("conversation") ??
				url.searchParams.get("session_key") ??
				this.callSessionFromName() ??
				DEFAULT_SESSION_KEY;
			this.#persistCtx(connection, {
				slug,
				isolateAgentId,
				tediId,
				organizationId,
				sessionKey,
				callId: `voice-${this.name}-${connection.id}-${Date.now()}`,
				startedAt: Date.now(),
				ttsCount: 0,
			});
		} catch (err) {
			logTediVoiceFailure("voice-call", "voice.context_capture_failed", err);
		}
		await super.onConnect(connection, ctx);
	}

	/**
	 * The VoiceCallDO instance name is `${slug}:${conversationKey}` (set by the
	 * edge via `idFromName`). These helpers recover the parts as a fallback when
	 * the WS URL did not carry explicit query params (defensive).
	 */
	private callSlugFromName(): string {
		const name = this.name ?? "";
		const idx = name.indexOf(":");
		return idx > 0 ? name.slice(0, idx) : name;
	}
	private callSessionFromName(): string | null {
		const name = this.name ?? "";
		const idx = name.indexOf(":");
		return idx > 0 ? name.slice(idx + 1) : null;
	}

	/**
	 * Gate auth/scope before a call starts. The Worker edge (`index.ts`) already
	 * authenticated the WS upgrade exactly like `/acp` (Tedi V2 JWT / gateway
	 * browser token via `Sec-WebSocket-Protocol: bearer-<token>`, or the
	 * service-binding bypass), so by the time we reach a constructed VoiceCallDO
	 * the connection is trusted. We only confirm the call context was captured
	 * (a missing context means the URL was malformed) — without it we cannot
	 * reach the canonical loop.
	 */
	override beforeCallStart(connection: Connection): boolean {
		const ctx = this.#getCtx(connection);
		if (!ctx) {
			logTediVoiceEvent("voice-call", "voice.call_context_missing", {
				connectionId: connection.id,
			});
			return false;
		}
		const claimed = this.#speakerGate.tryClaim(connection, {
			fields: () => ({ conn: connection.id, slug: ctx.slug }),
			log: (event, fields) => this.#vlog(event, fields),
		});
		if (claimed) {
			this.#activeConnectionId = connection.id;
			this.#activeContext = ctx;
		}
		return claimed;
	}

	override afterTranscribe(
		transcript: string,
		connection: Connection,
	): string | null {
		return filterVoiceUtterance(transcript, {
			fields: () => ({
				conn: connection.id,
				slug: this.#getCtx(connection)?.slug,
			}),
			log: (event, fields) => this.#vlog(event, fields),
		});
	}

	override async onCallStart(connection: Connection): Promise<void> {
		const ctx = this.#getCtx(connection);
		if (ctx) ctx.providerStartedAt = Date.now();
		this.#vlog("call.start", {
			conn: connection.id,
			slug: ctx?.slug,
			agent: ctx?.isolateAgentId,
		});
		await super.onCallStart(connection);
	}

	override async onInterrupt(connection: Connection): Promise<void> {
		this.#vlog("interrupt", { conn: connection.id });
		await super.onInterrupt(connection);
	}

	override onError(connectionOrError: unknown, maybeError?: unknown): void {
		const isConnectionError = maybeError !== undefined;
		const connection = isConnectionError
			? (connectionOrError as Connection)
			: undefined;
		const error = isConnectionError ? maybeError : connectionOrError;
		logTediVoiceFailure("voice-call", "voice.on_error", error, {
			connectionId: connection?.id,
			retryable: voiceErrorRetryable(error),
		});
	}

	/**
	 * EVERY voice turn consults the canonical tedi loop. We do NOT answer locally
	 * — the assistant text comes from `AgentTediDO.streamChatTurn` keyed on the
	 * SAME conversationId Tedix OS chat uses, so the turn flows through the session
	 * harness, cognitive ledger, brain bridge, and the tedi's MCP tools exactly
	 * like a typed chat message.
	 *
	 * STREAMING (SDK best practice, `@cloudflare/voice` docs): we return an
	 * `AsyncIterable<string>` so `withVoice` sentence-chunks the reply and
	 * synthesizes TTS CONCURRENTLY while the canonical turn is still generating,
	 * instead of waiting for the full text. `context.signal` (aborted on barge-in
	 * or disconnect) stops the delta stream; the SDK separately cancels queued
	 * playback via `onInterrupt`.
	 */
	override async onTurn(
		transcript: string,
		context: VoiceTurnContext,
	): Promise<string | AsyncIterable<string>> {
		const ctx = this.#getCtx(context.connection);
		if (!ctx) {
			logTediVoiceEvent("voice-call", "voice.turn_context_missing", {
				connectionId: context.connection.id,
			});
			return "Sorry, this voice call lost its session context. Please reconnect.";
		}
		this.#vlog("turn.start", {
			conn: context.connection.id,
			slug: ctx.slug,
			chars: transcript.length,
			history: context.messages.length,
		});
		const self = this;
		const conn = context.connection;
		const signal = context.signal;
		const startedAt = Date.now();
		return (async function* () {
			let chars = 0;
			try {
				for await (const delta of self.consultStream(
					ctx,
					{
						mode: "turn",
						text: transcript,
						// Per-utterance stable id → stable runId on the canonical side.
						client_request_id: `${ctx.callId}:${Date.now()}`,
					},
					signal,
				)) {
					chars += delta.length;
					yield delta;
				}
			} catch (err) {
				if (signal.aborted) {
					self.#vlog("turn.aborted", {
						conn: conn.id,
						ms: Date.now() - startedAt,
						replyChars: chars,
					});
					return;
				}
				logTediVoiceFailure("voice-call", "voice.turn_stream_failed", err, {
					connectionId: conn.id,
				});
				if (chars === 0) {
					yield "I ran into a problem reaching the agent. Please try again in a moment.";
				}
				return;
			}
			self.#vlog("turn.done", {
				conn: conn.id,
				ms: Date.now() - startedAt,
				replyChars: chars,
				empty: chars === 0,
			});
			if (chars === 0) {
				yield "I didn't catch a response for that — could you say it again?";
			}
		})();
	}

	/**
	 * Streaming consult: POST the voice turn to the canonical `AgentTediDO`'s
	 * `/__internal/voice/consult` (mode "turn"), which returns an SSE stream from
	 * `streamChatTurn`. Parse `data: {kind:"delta"|"done"|"error"}` frames and
	 * yield assistant delta text. `signal` aborts the read on barge-in/disconnect
	 * by cancelling the reader (unblocking an in-flight `read()`).
	 */
	private async *consultStream(
		ctx: VoiceCallContext,
		body: { mode: "turn"; text: string; client_request_id: string },
		signal: AbortSignal,
	): AsyncGenerator<string> {
		const ns = (
			this.env as unknown as {
				TEDI_AGENT: {
					idFromName(name: string): unknown;
					get(id: unknown): { fetch(req: Request): Promise<Response> };
				};
			}
		).TEDI_AGENT;
		const stub = ns.get(ns.idFromName(ctx.isolateAgentId));
		const req = new Request(
			`https://isolate.internal/__internal/voice/consult?slug=${encodeURIComponent(
				ctx.slug,
			)}`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "text/event-stream",
					"X-Service-Binding": "true",
					"X-Tedi-Slug": ctx.slug,
				},
				body: JSON.stringify({ session_key: ctx.sessionKey, ...body }),
			},
		);
		const res = await stub.fetch(req);
		if (!res.ok || !res.body) {
			const detail = res.ok
				? "no stream body"
				: `${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`;
			throw new Error(`voice consult stream failed: ${detail}`);
		}
		const reader = res.body.getReader();
		const onAbort = () => {
			void reader.cancel().catch(() => {});
		};
		signal.addEventListener("abort", onAbort, { once: true });
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			while (true) {
				if (signal.aborted) break;
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let sep = buffer.indexOf("\n\n");
				while (sep !== -1) {
					const rawEvent = buffer.slice(0, sep);
					buffer = buffer.slice(sep + 2);
					const dataLine = rawEvent
						.split("\n")
						.find((line) => line.startsWith("data:"));
					if (dataLine) {
						let frame: { kind?: string; text?: string; message?: string };
						try {
							frame = JSON.parse(
								dataLine.slice(dataLine.indexOf(":") + 1).trim(),
							);
						} catch {
							frame = {};
						}
						if (frame.kind === "delta" && typeof frame.text === "string") {
							yield frame.text;
						} else if (frame.kind === "error") {
							throw new Error(frame.message ?? "voice consult error");
						}
						// kind "done": stream closes next; deltas already yielded.
					}
					sep = buffer.indexOf("\n\n");
				}
			}
		} finally {
			signal.removeEventListener("abort", onAbort);
			try {
				await reader.cancel();
			} catch {
				/* best effort */
			}
		}
	}

	/**
	 * On call end, land a COMPACT recap of the call into the canonical session
	 * (mode:"recap"). Turn-level user/assistant speech is already durable via
	 * `streamChatTurn({ origin: "voice" })`; this recap is summary context and
	 * NOT the only record. Best-effort: a failed recap must not crash the DO.
	 *
	 * EMPTY-CALL GUARD: a call with no spoken turns (misclick, denied mic, a
	 * failed STT leg, or an immediate hang-up) must NOT consult a recap. Without
	 * this guard `buildVoiceCallRecap` still returns a "no transcript" header, so
	 * `landVoiceRecap` would inject a `user`/`assistant` turn pair into the
	 * canonical session AND fan out to the brain bridge, ledger, and daily log —
	 * noise the NEXT chat turn reads as context. We skip the consult entirely when
	 * there is no usable transcript, so a failed/empty call leaves no durable
	 * session trace by design.
	 */
	override async onCallEnd(connection: Connection): Promise<void> {
		// Clear single-speaker slot so the next caller is admitted.
		this.#speakerGate.release(connection);
		if (this.#activeConnectionId === connection.id) {
			this.#activeConnectionId = null;
			this.#activeContext = null;
		}
		const ctx = this.#getCtx(connection);
		if (ctx) await this.#recordSttUsage(ctx, Date.now());
		this.#ctxByConn.delete(connection.id);
		if (!ctx) return;
		try {
			const history = this.getConversationHistory();
			const transcript: VoiceRecapTurn[] = history
				.filter((m) => m.role === "user" || m.role === "assistant")
				.map((m) => ({
					role: m.role as "user" | "assistant",
					content: m.content,
				}))
				.filter(
					(t) => typeof t.content === "string" && t.content.trim().length > 0,
				);
			if (transcript.length === 0) {
				this.#vlog("recap.skipped", {
					conn: connection.id,
					slug: ctx.slug,
					reason: "no_transcript",
					ms: Date.now() - ctx.startedAt,
				});
				return;
			}
			const recap = buildVoiceCallRecap({
				transcript,
				durationMs: Date.now() - ctx.startedAt,
			});
			await this.consult(ctx, {
				mode: "recap",
				recap,
				// Stable per-CALL id so a recap retry dedups to one run.
				client_request_id: `${ctx.callId}:recap`,
			});
		} catch (err) {
			logTediVoiceFailure("voice-call", "voice.recap_failed", err, {
				connectionId: connection.id,
			});
		}
	}

	/**
	 * Socket-close safety net for single-speaker enforcement.
	 *
	 * The voice mixin's constructor captures any existing `onClose` method (an
	 * OWN property if already set, or a PROTOTYPE method — both work because the
	 * mixin uses `(this as any).onClose?.bind(this)` before installing its own
	 * OWN-property wrapper) and chains it: `_onClose?.(connection, ...rest)`.
	 * So this prototype override IS called when any socket closes.
	 *
	 * Why this is needed: the mixin's installed `onClose` calls
	 * `#cm.cleanup(connection.id)` + `#releaseKeepAlive` but does NOT call
	 * `#handleEndCall` (which is what calls `onCallEnd`). `onCallEnd` fires ONLY
	 * when an explicit `end_call` JSON frame arrives. A browser tab that crashes
	 * or is force-closed sends no `end_call`, so `onCallEnd` never fires —
	 * leaving the speaker gate set forever and blocking every future call.
	 * Clearing it here (idempotently, matching connection id) closes that gap.
	 */
	override onClose(connection: Connection, ...rest: unknown[]): void {
		const ctx = this.#getCtx(connection);
		if (this.#activeConnectionId === connection.id) {
			this.#activeConnectionId = null;
			this.#activeContext = null;
		}
		if (this.#speakerGate.release(connection)) {
			this.#vlog("call.speaker_slot_cleared", {
				conn: connection.id,
				reason: "socket_close",
			});
		}
		if (ctx) this.ctx.waitUntil(this.#recordSttUsage(ctx, Date.now()));
		this.#ctxByConn.delete(connection.id);
		// Chain to the SDK's own close handling (captured in the mixin constructor).
		(super.onClose as ((...args: unknown[]) => unknown) | undefined)?.(
			connection,
			...rest,
		);
	}

	/**
	 * Consult the canonical `AgentTediDO` via its namespace binding. The voice
	 * surface is Tedix-owned: we address the canonical loop by `isolateAgentId`
	 * (the SAME `idFromName` the edge uses for chat/MCP), stamp the
	 * service-binding trust headers the `/__internal/voice/consult` route
	 * expects, and POST the consult payload.
	 */
	private async consult(
		ctx: VoiceCallContext,
		body:
			| { mode: "turn"; text: string; client_request_id: string }
			| { mode: "recap"; recap: string; client_request_id: string },
	): Promise<unknown> {
		const ns = (
			this.env as unknown as {
				TEDI_AGENT: {
					idFromName(name: string): unknown;
					get(id: unknown): { fetch(req: Request): Promise<Response> };
				};
			}
		).TEDI_AGENT;
		const id = ns.idFromName(ctx.isolateAgentId);
		const stub = ns.get(id);
		const req = new Request(
			`https://isolate.internal/__internal/voice/consult?slug=${encodeURIComponent(
				ctx.slug,
			)}`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Service-Binding": "true",
					"X-Tedi-Slug": ctx.slug,
				},
				body: JSON.stringify({ session_key: ctx.sessionKey, ...body }),
			},
		);
		const res = await stub.fetch(req);
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(
				`voice consult failed: ${res.status} ${text.slice(0, 200)}`,
			);
		}
		return res.json();
	}
}
