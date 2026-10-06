/** STT-only browser dictation for the Tedix OS composer. */
import {
	type Transcriber,
	WorkersAIFluxSTT,
	withVoiceInput,
} from "@cloudflare/voice";
import type { RecordVoiceProviderUsageInput } from "@tedix/api-contract/schemas/billing";
import {
	createInstrumentedVoiceTranscriber,
	filterVoiceUtterance,
	installVoiceWireGuard,
	SingleSpeakerGate,
} from "@tedix/voice/runtime";
import { Agent, type Connection, type ConnectionContext } from "agents";
import { logKernelVoiceFailure } from "./kernel-voice-log";
import { type AiRunner, createVoiceGatewayAi } from "./voice-gateway-ai";

interface DictationContext {
	organizationId: string;
	callId: string;
	connectedAt: number;
	providerStartedAt?: number;
	gatewayLogId?: string | null;
	usageRecorded?: boolean;
}

const VoiceInputBase = withVoiceInput(Agent<Cloudflare.Env>);

export class KernelVoiceInputDO extends VoiceInputBase {
	static options = { hibernate: false, sendIdentityOnConnect: false };

	#activeContext: DictationContext | null = null;
	#contexts = new Map<string, DictationContext>();
	#speakerGate = new SingleSpeakerGate();

	transcriber = new WorkersAIFluxSTT(
		createVoiceGatewayAi({
			ai: () => this.#rawAi(),
			gatewayId: () =>
				(this.env as { AI_GATEWAY_LLM_ID?: string }).AI_GATEWAY_LLM_ID,
			channel: "voice-stt",
			attribution: () => {
				const context = this.#activeContext;
				return context
					? {
							organizationId: context.organizationId,
							sessionId: context.callId,
						}
					: null;
			},
			afterRun: ({ gatewayLogId }) => {
				if (this.#activeContext)
					this.#activeContext.gatewayLogId = gatewayLogId;
			},
		}),
		{ eotTimeoutMs: 3000 },
	);

	constructor(...args: ConstructorParameters<typeof VoiceInputBase>) {
		super(...args);
		installVoiceWireGuard(this, {
			log: (event, fields) => this.#log(event, fields),
		});
	}

	override createTranscriber(connection: Connection): Transcriber | null {
		return createInstrumentedVoiceTranscriber({
			base: this.transcriber,
			fields: () => ({
				conn: connection.id,
				orgId: this.#contexts.get(connection.id)?.organizationId,
			}),
			log: (event, fields) => this.#log(event, fields),
		});
	}

	override async onConnect(
		connection: Connection,
		context: ConnectionContext,
	): Promise<void> {
		try {
			(connection as { binaryType?: string }).binaryType = "arraybuffer";
		} catch {
			// Blob normalization in installVoiceWireGuard remains the fallback.
		}
		const organizationId =
			context.request.headers.get("X-Kernel-Organization-Id") ?? "";
		this.#contexts.set(connection.id, {
			organizationId,
			callId: `kernel-dictation-${this.name}-${connection.id}-${Date.now()}`,
			connectedAt: Date.now(),
		});
		await super.onConnect(connection, context);
	}

	override beforeCallStart(connection: Connection): boolean {
		const context = this.#contexts.get(connection.id);
		if (!context?.organizationId) return false;
		const claimed = this.#speakerGate.tryClaim(connection, {
			fields: () => ({ conn: connection.id, orgId: context.organizationId }),
			log: (event, fields) => this.#log(event, fields),
		});
		if (claimed) this.#activeContext = context;
		return claimed;
	}

	override afterTranscribe(
		transcript: string,
		connection: Connection,
	): string | null {
		return filterVoiceUtterance(transcript, {
			fields: () => ({
				conn: connection.id,
				orgId: this.#contexts.get(connection.id)?.organizationId,
			}),
			log: (event, fields) => this.#log(event, fields),
		});
	}

	override onCallStart(connection: Connection): void {
		const context = this.#contexts.get(connection.id);
		if (context) context.providerStartedAt = Date.now();
	}

	override async onCallEnd(connection: Connection): Promise<void> {
		this.#speakerGate.release(connection);
		const context = this.#contexts.get(connection.id);
		if (this.#activeContext === context) this.#activeContext = null;
		if (context) await this.#recordUsage(context, Date.now());
		this.#contexts.delete(connection.id);
	}

	override onClose(connection: Connection, ...rest: unknown[]): void {
		const context = this.#contexts.get(connection.id);
		this.#speakerGate.release(connection);
		if (this.#activeContext === context) this.#activeContext = null;
		if (context) this.ctx.waitUntil(this.#recordUsage(context, Date.now()));
		this.#contexts.delete(connection.id);
		(super.onClose as ((...args: unknown[]) => unknown) | undefined)?.(
			connection,
			...rest,
		);
	}

	#rawAi(): AiRunner {
		const ai = (this.env as { AI?: AiRunner }).AI;
		if (!ai) throw new Error("[KernelVoiceInputDO] AI binding unavailable");
		return ai;
	}

	async #recordUsage(
		context: DictationContext,
		endedAt: number,
	): Promise<void> {
		if (
			!context.providerStartedAt ||
			context.usageRecorded ||
			!context.organizationId
		)
			return;
		context.usageRecorded = true;
		const input: RecordVoiceProviderUsageInput = {
			organizationId: context.organizationId,
			providerUsageId: `workers-ai:voice-stt:${context.callId}`,
			gatewayLogId: context.gatewayLogId,
			provider: "workers-ai",
			model: "@cf/deepgram/flux",
			usageKind: "voice_stt",
			unit: "seconds",
			quantity: Math.max(
				1,
				Math.ceil((endedAt - context.providerStartedAt) / 1000),
			),
			occurredAt: new Date(endedAt).toISOString(),
			metadata: { callId: context.callId, channel: "voice-input" },
		};
		try {
			const [{ createDbClient }, { recordVoiceProviderUsage }] =
				await Promise.all([
					import("@tedix/db/client"),
					import("../lib/voice-provider-usage"),
				]);
			await recordVoiceProviderUsage(createDbClient(this.env.DB), input);
		} catch (error) {
			logKernelVoiceFailure("voice.input_usage_write_failed", error);
		}
	}

	#log(event: string, fields?: Record<string, unknown>): void {
		console.log(
			`[KernelVoiceInputDO] ${event}`,
			fields ? JSON.stringify(fields) : "",
		);
	}
}
