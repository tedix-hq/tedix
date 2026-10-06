import assert from "node:assert";

import {
	clampTtsText,
	hasAiGateway,
	hasAzureTts,
	MAX_TTS_CHARS,
	synthesizeSpeech,
	TtsError,
	type VoiceTtsEnv,
} from "./tts.ts";

/** Stub Workers AI binding returning fixed audio bytes (the aura-1 path). */
function stubAi(
	bytes: Uint8Array,
	capture?: (call: {
		model: unknown;
		input: unknown;
		options?: unknown;
	}) => void,
): Ai {
	return {
		run: async (model: unknown, input: unknown, options?: unknown) => {
			capture?.({ model, input, options });
			return bytes;
		},
	} as unknown as Ai;
}

const AUDIO = new Uint8Array([1, 2, 3, 4]);
const originalFetch = globalThis.fetch;

async function run() {
	// --- clampTtsText ---
	assert.equal(clampTtsText("  hi  "), "hi");
	const long = "a".repeat(MAX_TTS_CHARS + 50);
	const clamped = clampTtsText(long);
	assert.ok(clamped.length <= MAX_TTS_CHARS, "clamp caps length");
	assert.ok(clamped.endsWith("…"), "clamp marks truncation");

	// --- provider selection ---
	assert.equal(hasAzureTts({ AI: stubAi(AUDIO) }), false);
	assert.equal(
		hasAzureTts({
			AI: stubAi(AUDIO),
			AZURE_OPENAI_RESOURCE: "r",
			AI_GATEWAY_ACCOUNT_ID: "a",
			AI_GATEWAY_LLM_ID: "g",
			CF_AI_GATEWAY_TOKEN: "token",
		}),
		true,
	);
	assert.equal(
		hasAiGateway({
			AI: stubAi(AUDIO),
			AI_GATEWAY_ACCOUNT_ID: "a",
			AI_GATEWAY_LLM_ID: "g",
		}),
		true,
	);
	assert.equal(
		hasAiGateway({ AI: stubAi(AUDIO), AI_GATEWAY_LLM_ID: "g" }),
		false,
	);

	// --- Workers AI path (no Azure creds) ---
	{
		let seen: { model?: unknown; input?: unknown; options?: unknown } = {};
		const env: VoiceTtsEnv = {
			AI: stubAi(AUDIO, (c) => {
				seen = c;
			}),
		};
		const result = await synthesizeSpeech(env, { text: "hello there" });
		assert.equal(result.provider, "workers-ai");
		assert.deepEqual(Array.from(result.audio), [1, 2, 3, 4]);
		assert.equal(seen.model, "@cf/deepgram/aura-1");
		assert.equal((seen.input as { text: string }).text, "hello there");
		assert.equal(seen.options, undefined, "no gateway → no options");
	}

	// --- Workers AI gateway option ---
	{
		let seen: { options?: unknown } = {};
		const env: VoiceTtsEnv = {
			AI: stubAi(AUDIO, (c) => {
				seen = c;
			}),
			AI_GATEWAY_ACCOUNT_ID: "acct",
			AI_GATEWAY_LLM_ID: "gw",
		};
		await synthesizeSpeech(env, {
			text: "hi",
			gatewayMetadata: {
				orgId: "org-1",
				source: "voice-tts",
				usage: '{"k":"voice_tts","u":"characters","q":2}',
			},
		});
		assert.deepEqual(seen.options, {
			gateway: {
				id: "gw",
				metadata: {
					channel: "voice-tts",
					orgId: "org-1",
					source: "voice-tts",
					usage: '{"k":"voice_tts","u":"characters","q":2}',
				},
			},
		});
	}

	// --- coerceAudioBytes handles a ReadableStream return ---
	{
		const streamAi = {
			run: async () =>
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new Uint8Array([9, 9]));
						controller.close();
					},
				}),
		} as unknown as Ai;
		const result = await synthesizeSpeech({ AI: streamAi }, { text: "x" });
		assert.deepEqual(Array.from(result.audio), [9, 9]);
	}

	// --- Azure path (mock fetch returns audio) ---
	{
		globalThis.fetch = (async (url: string) => {
			assert.ok(
				String(url).includes(
					"/tedix-llm-production/azure-openai/myresource/gpt-4o-mini-tts/audio/speech",
				),
				"Azure deployment speech URL",
			);
			return new Response(new Uint8Array([5, 6, 7]), { status: 200 });
		}) as typeof fetch;
		const env: VoiceTtsEnv = {
			AI: stubAi(AUDIO),
			AZURE_OPENAI_RESOURCE: "myresource",
			AI_GATEWAY_ACCOUNT_ID: "acct",
			AI_GATEWAY_LLM_ID: "tedix-llm-production",
			CF_AI_GATEWAY_TOKEN: "token",
		};
		const result = await synthesizeSpeech(env, { text: "speak this" });
		assert.equal(result.provider, "azure");
		assert.deepEqual(Array.from(result.audio), [5, 6, 7]);
	}

	// --- Azure failure → Workers AI fallback ---
	{
		globalThis.fetch = (async () =>
			new Response("DeploymentNotFound", { status: 404 })) as typeof fetch;
		const env: VoiceTtsEnv = {
			AI: stubAi(new Uint8Array([42])),
			AZURE_OPENAI_RESOURCE: "r",
			AI_GATEWAY_ACCOUNT_ID: "acct",
			AI_GATEWAY_LLM_ID: "gateway",
			CF_AI_GATEWAY_TOKEN: "token",
		};
		const result = await synthesizeSpeech(env, { text: "rescue" });
		assert.equal(result.provider, "workers-ai");
		assert.deepEqual(Array.from(result.audio), [42]);
	}

	// --- both fail → throws TtsError ---
	{
		globalThis.fetch = (async () =>
			new Response("nope", { status: 500 })) as typeof fetch;
		const failingAi = {
			run: async () => ({}),
		} as unknown as Ai;
		const env: VoiceTtsEnv = {
			AI: failingAi,
			AZURE_OPENAI_RESOURCE: "r",
			AI_GATEWAY_ACCOUNT_ID: "acct",
			AI_GATEWAY_LLM_ID: "gateway",
			CF_AI_GATEWAY_TOKEN: "token",
		};
		await assert.rejects(
			() => synthesizeSpeech(env, { text: "fail" }),
			TtsError,
		);
	}

	// --- empty text rejects ---
	await assert.rejects(
		() => synthesizeSpeech({ AI: stubAi(AUDIO) }, { text: "   " }),
		TtsError,
	);

	globalThis.fetch = originalFetch;
	// --- AI Gateway binding transport ---
	{
		// Allowlisted in-account → the binding's fetch, on the binding host, with
		// no gateway token anywhere.
		const bindingCalls: Array<[string, RequestInit | undefined]> = [];
		const env: VoiceTtsEnv = {
			AI: {
				run: async () => AUDIO,
				fetch: async (url: string, init?: RequestInit) => {
					bindingCalls.push([url, init]);
					return new Response(AUDIO, { status: 200 });
				},
			} as unknown as Ai,
			AZURE_OPENAI_RESOURCE: "r",
			AI_GATEWAY_ACCOUNT_ID: "a",
			AI_GATEWAY_LLM_ID: "g",
			AI_GATEWAY_BINDING_PROVIDERS: "azure-openai",
		};
		assert.equal(hasAzureTts(env), true, "binding transport needs no token");
		globalThis.fetch = (() => {
			throw new Error("global fetch must not be used on the binding transport");
		}) as typeof fetch;
		const result = await synthesizeSpeech(env, { text: "hello" });
		globalThis.fetch = originalFetch;
		assert.equal(result.provider, "azure");
		assert.equal(bindingCalls.length, 1);
		assert.equal(
			bindingCalls[0]?.[0],
			"https://workers-binding.ai/ai-gateway/gateways/g/azure-openai/r/gpt-4o-mini-tts/audio/speech?api-version=2025-01-01-preview",
		);
		const headers = bindingCalls[0]?.[1]?.headers as Record<string, string>;
		assert.equal(
			headers["cf-aig-authorization"],
			"Bearer cloudflare-gateway-binding",
		);
	}
	{
		// NOT allowlisted (out-of-account gateway) → public HTTPS with its token.
		const httpCalls: Array<[string, RequestInit | undefined]> = [];
		const env: VoiceTtsEnv = {
			AI: {
				run: async () => AUDIO,
				fetch: async () => {
					throw new Error("binding must not be used for an HTTPS-only gateway");
				},
			} as unknown as Ai,
			AZURE_OPENAI_RESOURCE: "r",
			AI_GATEWAY_ACCOUNT_ID: "a",
			AI_GATEWAY_LLM_ID: "g",
			CF_AI_GATEWAY_TOKEN: "token",
			AI_GATEWAY_BINDING_PROVIDERS: "workers-ai",
		};
		globalThis.fetch = (async (url: string, init?: RequestInit) => {
			httpCalls.push([url, init]);
			return new Response(AUDIO, { status: 200 });
		}) as unknown as typeof fetch;
		const result = await synthesizeSpeech(env, { text: "hello" });
		globalThis.fetch = originalFetch;
		assert.equal(result.provider, "azure");
		assert.equal(
			httpCalls[0]?.[0],
			"https://gateway.ai.cloudflare.com/v1/a/g/azure-openai/r/gpt-4o-mini-tts/audio/speech?api-version=2025-01-01-preview",
		);
		const headers = httpCalls[0]?.[1]?.headers as Record<string, string>;
		assert.equal(headers["cf-aig-authorization"], "Bearer token");
	}

	console.log("voice/tts.test.ts: all assertions passed");
}

run().catch((err) => {
	globalThis.fetch = originalFetch;
	console.error(err);
	process.exit(1);
});
