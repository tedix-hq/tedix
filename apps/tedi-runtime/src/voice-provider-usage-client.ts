import { callRpc, serviceBindingFetch } from "@tedix/api-client/internal";
import type {
	RecordVoiceProviderUsageInput,
	RecordVoiceProviderUsageResponse,
} from "@tedix/api-contract/schemas/billing";
import {
	exceptionTopology,
	type ExceptionTopology,
} from "./exception-topology";

export interface VoiceProviderUsageEnv {
	API_SERVICE?: Fetcher;
}

function unwrapResponse(
	value: unknown,
): RecordVoiceProviderUsageResponse | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	const candidate =
		record.json && typeof record.json === "object" ? record.json : record;
	if (
		candidate &&
		typeof candidate === "object" &&
		typeof (candidate as { usageId?: unknown }).usageId === "string" &&
		typeof (candidate as { providerCostMicros?: unknown })
			.providerCostMicros === "number"
	) {
		return candidate as RecordVoiceProviderUsageResponse;
	}
	return null;
}

/**
 * Record Gateway-blind voice usage through the in-account API service binding.
 *
 * The call is idempotent by providerUsageId and retries transient failures. It
 * is fail-soft for the user-facing voice stream: provider inference already
 * happened, so a ledger outage is logged rather than turning valid audio into
 * a synthetic provider failure.
 */
export async function recordVoiceProviderUsage(
	env: VoiceProviderUsageEnv,
	input: RecordVoiceProviderUsageInput,
): Promise<RecordVoiceProviderUsageResponse | null> {
	if (!env.API_SERVICE) {
		console.error({ event: "voice.provider_usage_binding_missing" });
		return null;
	}
	let failureReason: "invalid_response" | "rpc_failed" = "invalid_response";
	let lastException: ExceptionTopology | undefined;
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			const result = await callRpc<RecordVoiceProviderUsageResponse>(
				"billing/recordVoiceProviderUsage",
				input,
				{
					apiUrl: "https://api",
					fetch: serviceBindingFetch(env.API_SERVICE),
					headers: {
						"X-Service-Binding": "true",
						"X-Tedix-Org-Id": "system",
					},
				},
			);
			if (unwrapResponse(result)) return result;
			failureReason = "invalid_response";
			lastException = undefined;
		} catch (error) {
			failureReason = "rpc_failed";
			lastException = exceptionTopology(error);
		}
	}
	console.error({
		event: "voice.provider_usage_write_failed",
		reason: failureReason,
		...(lastException && { exception: lastException }),
	});
	return null;
}
