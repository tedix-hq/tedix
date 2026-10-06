/**
 * apps/api — `KernelVoiceDO`: LIVE VOICE CALLS for the kernel.
 *
 * Sibling Durable Object to KernelDO. Keyed `${organizationId}:${conversation}`.
 * On each voice turn it runs startKernelTurn + runKernelTurnWork — the same
 * persist-first pipeline the HTTP path uses — then voice-shapes the result for TTS.
 *
 * Edge route: GET /kernel/voice/call (apps/api/src/index.ts)
 * Auth: shared kernel edge policy (scoped WS token primary, Descope session JWT fallback).
 * Tedix OS client: wss://{apiHost}/kernel/voice/call?organization={orgId}&conversation=home:main
 *             Sec-WebSocket-Protocol: bearer-<token>
 */

import {
	type Transcriber,
	type VoiceTurnContext,
	WorkersAIFluxSTT,
	WorkersAITTS,
	withVoice,
} from "@cloudflare/voice";
import type { RecordVoiceProviderUsageInput } from "@tedix/api-contract/schemas/billing";
import {
	createInstrumentedVoiceTranscriber,
	filterVoiceUtterance,
	installVoiceWireGuard,
	SingleSpeakerGate,
} from "@tedix/voice/runtime";
import { Agent, type Connection, type ConnectionContext } from "agents";

import { loadKernelTurnDelegation, loadTurnWork } from "./kernel-lazy";
import { logKernelVoiceEvent, logKernelVoiceFailure } from "./kernel-voice-log";
import {
	type AiRunner,
	createVoiceGatewayAi,
	type VoiceChannel,
} from "./voice-gateway-ai";
import { voiceShapeResult } from "./voice-helpers";

/** Per-call connection context stamped from the WS upgrade URL. */
interface KernelVoiceContext {
	organizationId: string;
	conversationKey: string;
	descopeUserId: string | null;
	callId: string;
	startedAt: number;
	/** Per-call turn counter for stable runId derivation. */
	turnCount: number;
	/** Set only after the provider STT session is live. */
	providerStartedAt?: number;
	sttGatewayLogId?: string | null;
	sttRecorded?: boolean;
	ttsCount: number;
}

const VOICE_CTX_STATE_KEY = "kernelVoiceCtx";

const VoiceAgentBase = withVoice(Agent<Cloudflare.Env>);

export class KernelVoiceDO extends VoiceAgentBase {
	static options = { hibernate: false, sendIdentityOnConnect: false };

	transcriber = new WorkersAIFluxSTT(this.voiceAi("voice-stt"), {
		eotTimeoutMs: 3000,
	});
	tts = new WorkersAITTS(this.voiceAi("voice-tts"));

	#ctxByConn = new Map<string, KernelVoiceContext>();
	#speakerGate = new SingleSpeakerGate();
	#activeConnectionId: string | null = null;
	#activeContext: KernelVoiceContext | null = null;

	constructor(...args: ConstructorParameters<typeof VoiceAgentBase>) {
		super(...args);
		installVoiceWireGuard(this, {
			log: (event, fields) => this.#vlog(event, fields),
		});
	}

	#persistCtx(connection: Connection, ctx: KernelVoiceContext): void {
		this.#ctxByConn.set(connection.id, ctx);
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
				conn.setState({ ...existing, [VOICE_CTX_STATE_KEY]: ctx });
			}
		} catch (err) {
			logKernelVoiceFailure("voice.context_persist_failed", err, {
				connectionId: connection.id,
			});
		}
	}

	#getCtx(connection: Connection): KernelVoiceContext | undefined {
		const cached = this.#ctxByConn.get(connection.id);
		if (cached) return cached;
		const state =
			(connection as { state?: unknown }).state &&
			typeof (connection as { state?: unknown }).state === "object"
				? ((connection as { state?: unknown }).state as Record<string, unknown>)
				: undefined;
		const persisted = state?.[VOICE_CTX_STATE_KEY] as
			| KernelVoiceContext
			| undefined;
		if (persisted) {
			this.#ctxByConn.set(connection.id, persisted);
			return persisted;
		}
		return undefined;
	}

	#vlog(event: string, fields?: Record<string, unknown>): void {
		const dev =
			(this.env as { ENVIRONMENT?: string }).ENVIRONMENT === "development";
		const safe =
			dev || !fields
				? fields
				: Object.fromEntries(
						Object.entries(fields).filter(([key]) => key !== "preview"),
					);
		console.log(`[KernelVoiceDO] ${event}`, safe ? JSON.stringify(safe) : "");
	}

	private rawAi(): AiRunner {
		const ai = (this.env as { AI?: AiRunner }).AI;
		if (!ai) throw new Error("[KernelVoiceDO] AI binding unavailable");
		return ai;
	}

	/**
	 * Gateway-routed runner for one voice channel. Fails closed at inference
	 * time when `AI_GATEWAY_LLM_ID` is absent — live voice must never run raw
	 * (Gateway-invisible) Workers AI inference.
	 */
	private voiceAi(channel: VoiceChannel): AiRunner {
		return createVoiceGatewayAi({
			ai: () => this.rawAi(),
			gatewayId: () =>
				(this.env as { AI_GATEWAY_LLM_ID?: string }).AI_GATEWAY_LLM_ID,
			channel,
			attribution: () => {
				const active = this.#activeContext;
				return active
					? { organizationId: active.organizationId, sessionId: active.callId }
					: null;
			},
			afterRun: ({ model, input, result, gatewayLogId }) => {
				const active = this.#activeContext;
				if (!active) return;
				if (channel === "voice-stt") {
					active.sttGatewayLogId = gatewayLogId;
					return;
				}
				if (result instanceof Response && !result.ok) return;
				const text = typeof input.text === "string" ? input.text : "";
				active.ttsCount += 1;
				this.ctx.waitUntil(
					this.#recordVoiceUsage({
						organizationId: active.organizationId,
						providerUsageId: `workers-ai:voice-tts:${active.callId}:${active.ttsCount}`,
						gatewayLogId,
						provider: "workers-ai",
						model,
						usageKind: "voice_tts",
						unit: "characters",
						quantity: Math.max(1, text.length),
						occurredAt: new Date().toISOString(),
						metadata: {
							callId: active.callId,
							channel,
							sequence: active.ttsCount,
						},
					}),
				);
			},
		});
	}

	async #recordVoiceUsage(input: RecordVoiceProviderUsageInput): Promise<void> {
		try {
			// Keep the billing/query graph off the cold voice isolate until a
			// successful provider call actually needs to be recorded.
			const [{ createDbClient }, { recordVoiceProviderUsage }] =
				await Promise.all([
					import("@tedix/db/client"),
					import("../lib/voice-provider-usage"),
				]);
			await recordVoiceProviderUsage(createDbClient(this.env.DB), input);
		} catch (error) {
			logKernelVoiceFailure("voice.usage_write_failed", error, {
				usageKind: input.usageKind,
			});
		}
	}

	async #recordSttUsage(
		ctx: KernelVoiceContext,
		endedAt: number,
	): Promise<void> {
		if (!ctx.providerStartedAt || ctx.sttRecorded) return;
		ctx.sttRecorded = true;
		await this.#recordVoiceUsage({
			organizationId: ctx.organizationId,
			providerUsageId: `workers-ai:voice-stt:${ctx.callId}`,
			gatewayLogId: ctx.sttGatewayLogId,
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

	override createTranscriber(connection: Connection): Transcriber | null {
		return createInstrumentedVoiceTranscriber({
			base: this.transcriber,
			fields: () => ({
				conn: connection.id,
				orgId: this.#getCtx(connection)?.organizationId,
			}),
			log: (event, fields) => this.#vlog(event, fields),
		});
	}

	override async onConnect(
		connection: Connection,
		ctx: ConnectionContext,
	): Promise<void> {
		try {
			(connection as { binaryType?: string }).binaryType = "arraybuffer";
		} catch {
			// older runtimes without settable binaryType
		}
		try {
			const url = new URL(ctx.request.url);
			// Edge stamps these from the validated identity headers (via ctx.request,
			// same as KernelDO.onConnect — ConnectionContext carries the request).
			const organizationId =
				url.searchParams.get("organization") ??
				ctx.request.headers.get("X-Kernel-Organization-Id") ??
				this.#orgFromName();
			const conversationKey =
				url.searchParams.get("conversation") ??
				this.#conversationFromName() ??
				"home:main";
			const descopeUserId =
				ctx.request.headers.get("X-Kernel-Descope-User-Id") ?? null;
			this.#persistCtx(connection, {
				organizationId,
				conversationKey,
				descopeUserId,
				callId: `kvoice-${this.name}-${connection.id}-${Date.now()}`,
				startedAt: Date.now(),
				turnCount: 0,
				ttsCount: 0,
			});
		} catch (err) {
			logKernelVoiceFailure("voice.context_capture_failed", err, {
				connectionId: connection.id,
			});
		}
		await super.onConnect(connection, ctx);
	}

	#orgFromName(): string {
		const name = this.name ?? "";
		const idx = name.indexOf(":");
		return idx > 0 ? name.slice(0, idx) : name;
	}

	#conversationFromName(): string | null {
		const name = this.name ?? "";
		const idx = name.indexOf(":");
		return idx > 0 ? name.slice(idx + 1) : null;
	}

	override beforeCallStart(connection: Connection): boolean {
		const ctx = this.#getCtx(connection);
		if (!ctx) {
			logKernelVoiceEvent("voice.call_context_missing", {
				stage: "before_call_start",
				connectionId: connection.id,
			});
			return false;
		}
		const claimed = this.#speakerGate.tryClaim(connection, {
			fields: () => ({ conn: connection.id, orgId: ctx.organizationId }),
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
				orgId: this.#getCtx(connection)?.organizationId,
			}),
			log: (event, fields) => this.#vlog(event, fields),
		});
	}

	override async onCallStart(connection: Connection): Promise<void> {
		const ctx = this.#getCtx(connection);
		if (ctx) ctx.providerStartedAt = Date.now();
		this.#vlog("call.start", {
			conn: connection.id,
			orgId: ctx?.organizationId,
			conversation: ctx?.conversationKey,
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
		const ctx = connection ? this.#getCtx(connection) : undefined;
		logKernelVoiceFailure("voice.call_failed", error, {
			connectionId: connection?.id,
			organizationId: ctx?.organizationId,
		});
	}

	/**
	 * NON-STREAMING v1: run the kernel turn (persist-first via startKernelTurn),
	 * voice-shape the result. Latency ack: 2.5s timer fires speak("One moment…")
	 * if the turn has not resolved. Returns a plain string (the SDK sentence-chunks
	 * and TTS-synthesizes it).
	 */
	override async onTurn(
		transcript: string,
		context: VoiceTurnContext,
	): Promise<string> {
		const ctx = this.#getCtx(context.connection);
		if (!ctx) {
			logKernelVoiceEvent("voice.call_context_missing", {
				stage: "turn",
				connectionId: context.connection.id,
			});
			return "Sorry, this voice call lost its session context. Please reconnect.";
		}

		// Increment turn counter for stable per-utterance runId
		ctx.turnCount = (ctx.turnCount ?? 0) + 1;
		const turnN = ctx.turnCount;
		const runId = `${ctx.callId}:turn:${turnN}`;

		this.#vlog("turn.start", {
			conn: context.connection.id,
			orgId: ctx.organizationId,
			chars: transcript.length,
			preview: transcript.slice(0, 120),
			turnN,
		});

		const startedAt = Date.now();

		// Latency ack: if turn takes >2.5s, speak "One moment…" once.
		let ackSent = false;
		const ackTimer = setTimeout(() => {
			if (!ackSent) {
				ackSent = true;
				this.speak(context.connection, "One moment…").catch(() => {});
			}
		}, 2500);

		try {
			const { createContext } = await import("../rpc/context");
			const turnContext = createContext(
				new Request("https://kernel-voice.internal/turn"),
				this.env,
			);

			// Loaded here rather than imported at module scope: these reach the
			// oRPC router graph, which would then be evaluated on every cold
			// isolate. See src/kernel/kernel-lazy.ts.
			const { startKernelTurn, buildKernelTurnWorkDeps } =
				await loadKernelTurnDelegation();
			const { runKernelTurnWork } = await loadTurnWork();

			// Persist-first (same as the HTTP path): startKernelTurn inserts
			// message.received + run.started + run row before the turn body runs.
			// The stable runId makes this idempotent.
			const turnInput = await startKernelTurn(turnContext, {
				organizationId: ctx.organizationId,
				conversationId: ctx.conversationKey,
				content: transcript,
				descopeUserId: ctx.descopeUserId ?? undefined,
				runId,
				source: "kernelVoice.onTurn",
			});

			const result = await runKernelTurnWork(
				buildKernelTurnWorkDeps(turnContext),
				turnInput,
			);

			clearTimeout(ackTimer);

			const spoken = voiceShapeResult(result);
			this.#vlog("turn.done", {
				conn: context.connection.id,
				orgId: ctx.organizationId,
				ms: Date.now() - startedAt,
				status: result.status,
				spokenChars: spoken.length,
				turnN,
			});
			return spoken;
		} catch (err) {
			clearTimeout(ackTimer);
			logKernelVoiceFailure("voice.turn_failed", err, {
				connectionId: context.connection.id,
				organizationId: ctx.organizationId,
			});
			return "I ran into a problem reaching the kernel. Please try again in a moment.";
		}
	}

	override async onCallEnd(connection: Connection): Promise<void> {
		this.#speakerGate.release(connection);
		if (this.#activeConnectionId === connection.id) {
			this.#activeConnectionId = null;
			this.#activeContext = null;
		}
		const ctx = this.#getCtx(connection);
		if (ctx) await this.#recordSttUsage(ctx, Date.now());
		this.#ctxByConn.delete(connection.id);
		if (ctx) {
			this.#vlog("call.end", {
				conn: connection.id,
				orgId: ctx.organizationId,
				ms: Date.now() - ctx.startedAt,
				turns: ctx.turnCount,
			});
		}
	}

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
		(super.onClose as ((...args: unknown[]) => unknown) | undefined)?.(
			connection,
			...rest,
		);
	}
}
