/**
 * voice-billing — the credit admission seam for paid voice calls.
 *
 * Speech-to-text and text-to-speech are priced by their own unit, not tokens:
 * audio seconds for transcription, input characters for speech. Before each
 * provider attempt the caller's {@link VoiceBilling} reserves credits for an
 * upper bound of that unit; after the attempt it settles the measured units or
 * releases the hold. A refusal for the organization (credits, caps) stops the
 * call; a refusal for one unpriced model lets the next provider run.
 *
 * This package only describes the attempt. The API owns pricing and the credit
 * pool (`apps/api/src/services/voice-billing.ts`).
 */

import { aiGatewayCustomCost } from "@tedix/workers-ai/gateway-transport";

/**
 * `cf-aig-custom-cost` for Azure voice requests. Tedix prices voice per audio
 * second or character, which AI Gateway's per-token custom cost cannot
 * express. Zero token rates keep the Gateway from attaching a public token
 * price to an audio request; the credit charge comes from the governed
 * per-unit rate at settlement.
 */
export const VOICE_GATEWAY_CUSTOM_COST = aiGatewayCustomCost({
	inputMicrousdPerMillion: 0,
	outputMicrousdPerMillion: 0,
	cacheReadMicrousdPerMillion: 0,
	cacheWriteMicrousdPerMillion: 0,
});

export type VoiceUsageKind = "voice_stt" | "voice_tts";
export type VoiceUsageUnit = "seconds" | "characters";

export interface VoiceBillingAttempt {
	provider: "azure-openai" | "workers-ai";
	/** Azure deployment, or the Workers AI model id. */
	model: string;
	/**
	 * Governed-rate scope, built the same way as `providerDeploymentScope` in
	 * `@tedix/api-contract/schemas/provider-execution`.
	 */
	deploymentScope: string;
	usageKind: VoiceUsageKind;
	unit: VoiceUsageUnit;
	/** Upper bound of the units this attempt can consume. */
	estimatedQuantity: number;
}

export interface VoiceUsageMeasurement {
	quantity: number;
	/** False when the provider reported no duration and the estimate is charged. */
	measured: boolean;
}

export interface VoiceBillingHold {
	settle(usage: VoiceUsageMeasurement): Promise<void>;
	release(reason: string): Promise<void>;
}

export interface VoiceBilling {
	/** Reserve credits for one provider attempt; throws when admission refuses. */
	admit(attempt: VoiceBillingAttempt): Promise<VoiceBillingHold>;
}

/**
 * An admission refusal. `attempt` refuses only this provider and model (it has
 * no governed rate), so the next provider may still be tried; `call` refuses
 * the organization (credits, caps, subscription) and ends the call.
 */
export class VoiceBillingRefusal extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly scope: "attempt" | "call",
	) {
		super(message);
		this.name = "VoiceBillingRefusal";
	}
}

/**
 * Admit an attempt that has a fallback provider after it. Returns `null` when
 * only this attempt is refused, so the caller moves to the next provider; any
 * other refusal throws.
 */
export async function admitWithFallback(
	billing: VoiceBilling | undefined,
	attempt: VoiceBillingAttempt,
	channel: string,
): Promise<{ hold: VoiceBillingHold | undefined } | null> {
	try {
		return { hold: await billing?.admit(attempt) };
	} catch (error) {
		if (!(error instanceof VoiceBillingRefusal) || error.scope !== "attempt")
			throw error;
		console.warn(
			`[${channel}] ${attempt.provider}/${attempt.model} refused (${error.code}), trying the next provider`,
		);
		return null;
	}
}

/** Gateway env needed to name a voice attempt's rate scope. */
export interface VoiceRateScopeEnv {
	AI_GATEWAY_ACCOUNT_ID?: string;
	AI_GATEWAY_LLM_ID?: string;
}

export function azureVoiceDeploymentScope(
	env: VoiceRateScopeEnv,
	resource: string,
	deployment: string,
): string {
	return JSON.stringify([
		"azure-openai",
		env.AI_GATEWAY_ACCOUNT_ID?.trim() ?? null,
		env.AI_GATEWAY_LLM_ID?.trim() ?? null,
		`https://${resource.trim().toLowerCase()}.openai.azure.com`,
		deployment,
	]);
}

export function workersAiVoiceDeploymentScope(env: VoiceRateScopeEnv): string {
	return JSON.stringify([
		"workers-ai",
		env.AI_GATEWAY_ACCOUNT_ID?.trim() ?? null,
	]);
}

/**
 * Lowest bitrate assumed when bounding a recording's length from its size.
 * Browser voice recordings (Opus in WebM/Ogg, AAC in MP4) run well above this,
 * so the bound is safe for the hold; settlement charges the measured length.
 */
const MIN_AUDIO_BITS_PER_SECOND = 12_000;

/** Upper bound of a recording's length in whole seconds, from its byte size. */
export function estimateAudioSeconds(byteLength: number): number {
	return Math.max(1, Math.ceil((byteLength * 8) / MIN_AUDIO_BITS_PER_SECOND));
}

/**
 * Settle a successful attempt, logging instead of failing the caller: the
 * user already has the transcript or audio, and an unsettled hold expires.
 */
export async function settleVoiceHold(
	hold: VoiceBillingHold | undefined,
	usage: VoiceUsageMeasurement,
	channel: string,
): Promise<void> {
	if (!hold) return;
	try {
		await hold.settle(usage);
	} catch (error) {
		console.error(
			`[${channel}] voice credit settlement failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/** Release a failed attempt's hold; a failed release only delays the expiry. */
export async function releaseVoiceHold(
	hold: VoiceBillingHold | undefined,
	reason: string,
	channel: string,
): Promise<void> {
	if (!hold) return;
	try {
		await hold.release(reason);
	} catch (error) {
		console.error(
			`[${channel}] voice credit release failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
