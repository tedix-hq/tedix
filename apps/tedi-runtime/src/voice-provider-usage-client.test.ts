import assert from "node:assert/strict";
import { recordVoiceProviderUsage } from "./voice-provider-usage-client";

const input = {
	organizationId: "org-1",
	tediId: "tedi-1",
	providerUsageId: "voice:call-1",
	provider: "workers-ai",
	model: "@cf/deepgram/flux",
	usageKind: "voice_stt" as const,
	unit: "seconds" as const,
	quantity: 12,
	occurredAt: "2026-07-31T12:00:00.000Z",
};

{
	const requests: Request[] = [];
	const result = await recordVoiceProviderUsage(
		{
			API_SERVICE: {
				fetch: async (request: Request) => {
					requests.push(request);
					return Response.json({
						json: {
							usageId: "usage-1",
							providerCostMicros: 1_540,
							providerCostQuality: "estimated",
							rateCardVersion: "workers-ai-2026-07-31",
						},
					});
				},
			} as unknown as Fetcher,
		},
		input,
	);
	assert.equal(result?.usageId, "usage-1");
	assert.equal(requests.length, 1);
	assert.equal(
		new URL(requests[0]?.url ?? "https://invalid").pathname,
		"/rpc/billing/recordVoiceProviderUsage",
	);
	const body = (await requests[0]?.json()) as { json?: unknown };
	assert.deepEqual(body.json, input);
}

{
	let attempts = 0;
	const result = await recordVoiceProviderUsage(
		{
			API_SERVICE: {
				fetch: async () => {
					attempts++;
					if (attempts < 3) return new Response("retry", { status: 503 });
					return Response.json({
						json: {
							usageId: "usage-2",
							providerCostMicros: 1_540,
							providerCostQuality: "estimated",
							rateCardVersion: "workers-ai-2026-07-31",
						},
					});
				},
			} as unknown as Fetcher,
		},
		input,
	);
	assert.equal(attempts, 3);
	assert.equal(result?.usageId, "usage-2");
}

{
	const logged: unknown[][] = [];
	const originalError = console.error;
	console.error = (...values: unknown[]) => {
		logged.push(values);
	};
	let attempts = 0;
	try {
		const result = await recordVoiceProviderUsage(
			{
				API_SERVICE: {
					fetch: async () => {
						attempts++;
						throw new Error("private-provider-response", {
							cause: new TypeError("private-account-detail"),
						});
					},
				} as unknown as Fetcher,
			},
			{ ...input, providerUsageId: "private-provider-usage-id" },
		);
		assert.equal(result, null);
	} finally {
		console.error = originalError;
	}
	assert.equal(attempts, 3);
	assert.deepEqual(logged, [
		[
			{
				event: "voice.provider_usage_write_failed",
				reason: "rpc_failed",
				exception: { type: "Error", cause: { type: "TypeError" } },
			},
		],
	]);
	assert(!JSON.stringify(logged).includes("private-"));
}

{
	const logged: unknown[][] = [];
	const originalError = console.error;
	console.error = (...values: unknown[]) => {
		logged.push(values);
	};
	let attempts = 0;
	try {
		const result = await recordVoiceProviderUsage(
			{
				API_SERVICE: {
					fetch: async () => {
						attempts++;
						return Response.json({ json: { detail: "private-response" } });
					},
				} as unknown as Fetcher,
			},
			input,
		);
		assert.equal(result, null);
	} finally {
		console.error = originalError;
	}
	assert.equal(attempts, 3);
	assert.deepEqual(logged, [
		[
			{
				event: "voice.provider_usage_write_failed",
				reason: "invalid_response",
			},
		],
	]);
}

{
	const logged: unknown[][] = [];
	const originalError = console.error;
	console.error = (...values: unknown[]) => {
		logged.push(values);
	};
	try {
		assert.equal(await recordVoiceProviderUsage({}, input), null);
	} finally {
		console.error = originalError;
	}
	assert.deepEqual(logged, [
		[{ event: "voice.provider_usage_binding_missing" }],
	]);
}

console.log("voice-provider-usage-client.test.ts: all assertions passed");
