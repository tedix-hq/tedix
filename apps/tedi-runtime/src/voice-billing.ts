import {
	type RuntimeVoiceAdmission,
	type RuntimeVoiceAdmissionResult,
	type RuntimeVoiceCompletion,
	type VoiceBilling,
	VoiceBillingRefusal,
	releaseVoiceHold,
	settleVoiceHold,
	workersAiVoiceDeploymentScope,
} from "@tedix/voice/billing";

export function runtimeVoiceBilling(
	env: Pick<Cloudflare.Env, "API_SERVICE" | "TEDIX_BILLING_SETTLEMENT_MODE">,
	subject: Omit<RuntimeVoiceAdmission, "attempt">,
): VoiceBilling | undefined {
	const mode = env.TEDIX_BILLING_SETTLEMENT_MODE;
	if (mode === "external" || mode === "disabled") return undefined;
	return {
		async admit(attempt) {
			if (mode !== "managed" || !env.API_SERVICE || !subject.organizationId)
				throw new Error("Voice credit admission is unavailable");
			const api = env.API_SERVICE as unknown as {
				reserveRuntimeVoice(
					input: RuntimeVoiceAdmission,
				): Promise<RuntimeVoiceAdmissionResult>;
				finishRuntimeVoice(input: RuntimeVoiceCompletion): Promise<void>;
			};
			const decision = await api.reserveRuntimeVoice({
				organizationId: subject.organizationId,
				tediId: subject.tediId,
				userId: subject.userId,
				attempt,
			});
			if ("refusal" in decision) {
				const { code, message, scope } = decision.refusal;
				throw new VoiceBillingRefusal(code, message, scope);
			}
			const receipt = {
				organizationId: subject.organizationId,
				reservationId: decision.reservationId,
			};
			return {
				settle: (usage) => api.finishRuntimeVoice({ ...receipt, usage }),
				release: (reason) => api.finishRuntimeVoice({ ...receipt, reason }),
			};
		},
	};
}

type WorkersAiRunner = {
	run(
		model: string,
		input: Record<string, unknown>,
		options?: Record<string, unknown>,
	): Promise<unknown>;
};

// Each provider connection has a finite hold. The transcriber can reopen a
// connection after this one closes, with a new admission for that connection.
const MAX_STREAM_SECONDS = 300;

export function billStreamingTranscription(
	ai: WorkersAiRunner,
	env: Cloudflare.Env,
	subject: Omit<RuntimeVoiceAdmission, "attempt"> | undefined,
	waitUntil: (work: Promise<void>) => void,
): WorkersAiRunner {
	return {
		async run(model, input, options) {
			if (!subject)
				throw new Error("Missing attribution for live transcription");
			const billing = runtimeVoiceBilling(env, subject);
			if (!billing) return ai.run(model, input, options);
			const hold = await billing.admit({
				provider: "workers-ai",
				model,
				deploymentScope: workersAiVoiceDeploymentScope(env),
				usageKind: "voice_stt",
				unit: "seconds",
				estimatedQuantity: MAX_STREAM_SECONDS,
			});
			let result: unknown;
			try {
				result = await ai.run(model, input, options);
			} catch (error) {
				await releaseVoiceHold(hold, "provider_failed", "voice-stt");
				throw error;
			}
			const socket = result instanceof Response ? result.webSocket : null;
			if (!socket) {
				await releaseVoiceHold(hold, "provider_failed", "voice-stt");
				return result;
			}
			const startedAt = Date.now();
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				clearTimeout(deadline);
				const quantity = Math.max(
					1,
					Math.ceil((Date.now() - startedAt) / 1000),
				);
				waitUntil(
					settleVoiceHold(hold, { quantity, measured: false }, "voice-stt"),
				);
			};
			const deadline = setTimeout(() => {
				if (socket.readyState === WebSocket.OPEN)
					socket.close(1000, "Voice reservation elapsed");
				finish();
			}, MAX_STREAM_SECONDS * 1000);
			socket.addEventListener("close", finish, { once: true });
			return result;
		},
	};
}
