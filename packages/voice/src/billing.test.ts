import assert from "node:assert/strict";

import {
	estimateAudioSeconds,
	VOICE_GATEWAY_CUSTOM_COST,
	type VoiceBilling,
	type VoiceBillingAttempt,
	VoiceBillingRefusal,
	type VoiceUsageMeasurement,
} from "./billing";
import { type AudioAttachment, transcribeAudioAttachment } from "./stt";
import { synthesizeSpeech } from "./tts";

type Event =
	| { type: "admit"; attempt: VoiceBillingAttempt }
	| { type: "settle"; provider: string; usage: VoiceUsageMeasurement }
	| { type: "release"; provider: string; reason: string };

function recordingBilling(refuse?: (attempt: VoiceBillingAttempt) => boolean): {
	billing: VoiceBilling;
	events: Event[];
} {
	const events: Event[] = [];
	return {
		events,
		billing: {
			async admit(attempt) {
				events.push({ type: "admit", attempt });
				if (refuse?.(attempt))
					throw new Error(
						"Inference blocked by billing policy: monthly_credit_limit_reached",
					);
				return {
					async settle(usage) {
						events.push({ type: "settle", provider: attempt.provider, usage });
					},
					async release(reason) {
						events.push({
							type: "release",
							provider: attempt.provider,
							reason,
						});
					},
				};
			},
		},
	};
}

function stubAi(result: unknown, calls: unknown[] = []): Ai {
	return {
		run: async (...args: unknown[]) => {
			calls.push(args);
			return result;
		},
	} as unknown as Ai;
}

// 3,000 bytes of audio: at the 12 kbps floor that bounds the clip at 2 s.
const AUDIO: AudioAttachment = {
	type: "audio",
	content: btoa("x".repeat(3_000)),
	fileName: "note.webm",
	mimeType: "audio/webm",
};

const azureEnv = {
	AZURE_OPENAI_RESOURCE: "MyResource",
	AZURE_OPENAI_STT_DEPLOYMENT: "gpt-transcribe",
	AZURE_OPENAI_TTS_DEPLOYMENT: "gpt-4o-mini-tts",
	AI_GATEWAY_ACCOUNT_ID: "acct",
	AI_GATEWAY_LLM_ID: "gw",
	CF_AI_GATEWAY_TOKEN: "token",
};

const originalFetch = globalThis.fetch;

async function run() {
	assert.equal(estimateAudioSeconds(1), 1);
	assert.equal(estimateAudioSeconds(3_000), 2);
	assert.equal(estimateAudioSeconds(1_500_000), 1_000);
	assert.equal(
		VOICE_GATEWAY_CUSTOM_COST,
		'{"per_token_in":0,"per_token_out":0,"per_cache_read_token":0,"per_cache_write_token":0}',
	);

	// Workers AI transcription: admitted for the size bound, settled on the
	// measured length whisper reports.
	{
		const { billing, events } = recordingBilling();
		const result = await transcribeAudioAttachment(
			{
				AI: stubAi({ text: "hi", words: [{ end: 0.4 }, { end: 1.2 }] }),
				AI_GATEWAY_ACCOUNT_ID: "acct",
			},
			AUDIO,
			{ billing },
		);
		assert.equal(result.provider, "workers-ai");
		assert.deepEqual(events, [
			{
				type: "admit",
				attempt: {
					provider: "workers-ai",
					model: "@cf/openai/whisper",
					deploymentScope: '["workers-ai","acct"]',
					usageKind: "voice_stt",
					unit: "seconds",
					estimatedQuantity: 2,
				},
			},
			{
				type: "settle",
				provider: "workers-ai",
				usage: { quantity: 2, measured: true },
			},
		]);
	}

	// No word timings: the size bound is charged and marked unmeasured.
	{
		const { billing, events } = recordingBilling();
		await transcribeAudioAttachment({ AI: stubAi({ text: "" }) }, AUDIO, {
			billing,
		});
		assert.deepEqual(events.at(-1), {
			type: "settle",
			provider: "workers-ai",
			usage: { quantity: 2, measured: false },
		});
	}

	// Azure transcription carries the payer and price headers and settles the
	// duration Azure reports.
	{
		const { billing, events } = recordingBilling();
		let headers: Record<string, string> = {};
		globalThis.fetch = (async (_url: string, init: RequestInit) => {
			headers = init.headers as Record<string, string>;
			return new Response(
				JSON.stringify({
					text: "azure",
					usage: { type: "duration", seconds: 1.3 },
				}),
			);
		}) as typeof fetch;
		const result = await transcribeAudioAttachment(
			{ AI: stubAi({ text: "unused" }), ...azureEnv },
			AUDIO,
			{ billing, gatewayMetadata: { orgId: "org-1", tediId: "tedi-1" } },
		);
		assert.equal(result.provider, "azure");
		assert.equal(headers["cf-aig-no-wholesale"], "true");
		assert.equal(headers["cf-aig-custom-cost"], VOICE_GATEWAY_CUSTOM_COST);
		assert.deepEqual(JSON.parse(headers["cf-aig-metadata"]!), {
			channel: "voice-stt",
			orgId: "org-1",
			tediId: "tedi-1",
			usage: '{"k":"voice_stt","u":"units","q":1}',
		});
		assert.deepEqual(events, [
			{
				type: "admit",
				attempt: {
					provider: "azure-openai",
					model: "gpt-transcribe",
					deploymentScope:
						'["azure-openai","acct","gw","https://myresource.openai.azure.com","gpt-transcribe"]',
					usageKind: "voice_stt",
					unit: "seconds",
					estimatedQuantity: 2,
				},
			},
			{
				type: "settle",
				provider: "azure-openai",
				usage: { quantity: 2, measured: true },
			},
		]);
	}

	// A failed Azure attempt releases its hold before Workers AI is admitted.
	{
		const { billing, events } = recordingBilling();
		const warn = console.warn;
		console.warn = () => {};
		globalThis.fetch = (async () =>
			new Response("DeploymentNotFound", { status: 404 })) as typeof fetch;
		const result = await transcribeAudioAttachment(
			{ AI: stubAi({ text: "rescued" }), ...azureEnv },
			AUDIO,
			{ billing },
		);
		console.warn = warn;
		assert.equal(result.provider, "workers-ai");
		assert.deepEqual(
			events.map((event) =>
				event.type === "admit"
					? `admit:${event.attempt.provider}`
					: `${event.type}:${event.provider}`,
			),
			[
				"admit:azure-openai",
				"release:azure-openai",
				"admit:workers-ai",
				"settle:workers-ai",
			],
		);
	}

	// A refusal stops the call: no provider request and no fallback.
	{
		const { billing, events } = recordingBilling(() => true);
		let fetched = false;
		const aiCalls: unknown[] = [];
		globalThis.fetch = (async () => {
			fetched = true;
			return new Response("{}");
		}) as typeof fetch;
		await assert.rejects(
			transcribeAudioAttachment(
				{ AI: stubAi({ text: "x" }, aiCalls), ...azureEnv },
				AUDIO,
				{ billing },
			),
			/billing policy: monthly_credit_limit_reached/,
		);
		assert.equal(fetched, false);
		assert.equal(aiCalls.length, 0);
		assert.equal(events.length, 1);
	}

	// An unpriced Azure deployment is refused for that attempt only: the call
	// moves to the next provider without contacting Azure.
	{
		const events: string[] = [];
		let fetched = false;
		globalThis.fetch = (async () => {
			fetched = true;
			return new Response("{}");
		}) as typeof fetch;
		const warn = console.warn;
		console.warn = () => {};
		const billing: VoiceBilling = {
			async admit(attempt) {
				events.push(`admit:${attempt.provider}`);
				if (attempt.provider === "azure-openai")
					throw new VoiceBillingRefusal(
						"pricing_unavailable",
						"Inference blocked by billing policy: pricing_unavailable",
						"attempt",
					);
				return {
					settle: async () => void events.push(`settle:${attempt.provider}`),
					release: async () => {},
				};
			},
		};
		const stt = await transcribeAudioAttachment(
			{ AI: stubAi({ text: "whisper" }), ...azureEnv },
			AUDIO,
			{ billing },
		);
		const tts = await synthesizeSpeech(
			{ AI: stubAi(new Uint8Array([1])), ...azureEnv },
			{ text: "hey", billing },
		);
		console.warn = warn;
		assert.equal(stt.provider, "workers-ai");
		assert.equal(tts.provider, "workers-ai");
		assert.equal(fetched, false);
		assert.deepEqual(events, [
			"admit:azure-openai",
			"admit:workers-ai",
			"settle:workers-ai",
			"admit:azure-openai",
			"admit:workers-ai",
			"settle:workers-ai",
		]);
	}

	// Speech is admitted and settled on its input characters.
	{
		const { billing, events } = recordingBilling();
		const calls: unknown[] = [];
		const result = await synthesizeSpeech(
			{ AI: stubAi(new Uint8Array([1]), calls), AI_GATEWAY_ACCOUNT_ID: "acct" },
			{ text: "  héllo  ", billing },
		);
		assert.equal(result.provider, "workers-ai");
		assert.deepEqual(events, [
			{
				type: "admit",
				attempt: {
					provider: "workers-ai",
					model: "@cf/deepgram/aura-1",
					deploymentScope: '["workers-ai","acct"]',
					usageKind: "voice_tts",
					unit: "characters",
					estimatedQuantity: 5,
				},
			},
			{
				type: "settle",
				provider: "workers-ai",
				usage: { quantity: 5, measured: true },
			},
		]);
	}

	// Azure speech: price headers, character usage envelope, refusal skips Aura.
	{
		const { billing } = recordingBilling();
		let headers: Record<string, string> = {};
		globalThis.fetch = (async (_url: string, init: RequestInit) => {
			headers = init.headers as Record<string, string>;
			return new Response(new Uint8Array([9]));
		}) as typeof fetch;
		const result = await synthesizeSpeech(
			{ AI: stubAi(new Uint8Array([1])), ...azureEnv },
			{ text: "hey", billing, gatewayMetadata: { orgId: "org-1" } },
		);
		assert.equal(result.provider, "azure");
		assert.equal(headers["cf-aig-no-wholesale"], "true");
		assert.equal(headers["cf-aig-custom-cost"], VOICE_GATEWAY_CUSTOM_COST);
		assert.deepEqual(JSON.parse(headers["cf-aig-metadata"]!), {
			channel: "voice-tts",
			orgId: "org-1",
			usage: '{"k":"voice_tts","u":"characters","q":3}',
		});

		const refused = recordingBilling(() => true);
		const aiCalls: unknown[] = [];
		await assert.rejects(
			synthesizeSpeech(
				{ AI: stubAi(new Uint8Array([1]), aiCalls), ...azureEnv },
				{ text: "hey", billing: refused.billing },
			),
			/billing policy/,
		);
		assert.equal(aiCalls.length, 0);
	}

	// A settlement failure is logged; the caller still gets its result.
	{
		const errors: unknown[] = [];
		const error = console.error;
		console.error = (...args: unknown[]) => errors.push(args);
		const result = await synthesizeSpeech(
			{ AI: stubAi(new Uint8Array([1])) },
			{
				text: "ok",
				billing: {
					admit: async () => ({
						settle: async () => {
							throw new Error("D1 unavailable");
						},
						release: async () => {},
					}),
				},
			},
		);
		console.error = error;
		assert.equal(result.provider, "workers-ai");
		assert.equal(errors.length, 1);
	}
}

try {
	await run();
	console.log("voice/billing.test.ts: all assertions passed");
} finally {
	globalThis.fetch = originalFetch;
}
