/**
 * Unit tests for the Gateway-routed voice AI runner.
 *
 * Covers the AI Gateway coverage contract for live kernel voice:
 *   1. Flux STT runs through the configured Gateway id with `voice-stt`
 *      channel/source and a `voice_stt` usage envelope.
 *   2. The Flux-required `websocket: true` option survives wrapper composition.
 *   3. TTS stays attributed as `voice-tts` with a character usage envelope.
 *   4. Caller-supplied options, gateway options, and metadata are merged, not
 *      overwritten (the gateway id itself is enforced).
 *   5. Missing Gateway configuration fails closed — the raw binding is never
 *      called.
 *   6. Organization/session attribution is stamped when the call context
 *      provides it and omitted when it does not.
 */

import { describe, expect, it, vi } from "vite-plus/test";
import { type AiRunner, createVoiceGatewayAi } from "./voice-gateway-ai";

interface RecordedCall {
	model: string;
	input: Record<string, unknown>;
	options: Record<string, unknown> | undefined;
}

function recordingAi(): { ai: AiRunner; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	return {
		ai: {
			run: (model, input, options) => {
				calls.push({ model, input, options });
				return Promise.resolve({ ok: true });
			},
		},
		calls,
	};
}

function gatewayOf(call: RecordedCall): Record<string, unknown> {
	return call.options?.gateway as Record<string, unknown>;
}

function metadataOf(call: RecordedCall): Record<string, unknown> {
	return gatewayOf(call).metadata as Record<string, unknown>;
}

describe("createVoiceGatewayAi — voice-stt (Flux)", () => {
	it("routes @cf/deepgram/flux through the configured Gateway id", async () => {
		const { ai, calls } = recordingAi();
		const runner = createVoiceGatewayAi({
			ai: () => ai,
			gatewayId: () => "tedix-llm-production",
			channel: "voice-stt",
			attribution: () => null,
		});
		await runner.run(
			"@cf/deepgram/flux",
			{ encoding: "linear16", sample_rate: "16000" },
			{ websocket: true },
		);
		expect(calls).toHaveLength(1);
		expect(gatewayOf(calls[0]).id).toBe("tedix-llm-production");
	});

	it("preserves the Flux-required websocket:true option", async () => {
		const { ai, calls } = recordingAi();
		const runner = createVoiceGatewayAi({
			ai: () => ai,
			gatewayId: () => "tedix-llm-production",
			channel: "voice-stt",
			attribution: () => null,
		});
		await runner.run("@cf/deepgram/flux", {}, { websocket: true });
		expect(calls[0].options?.websocket).toBe(true);
	});

	it("stamps channel/source voice-stt and a voice_stt session usage envelope", async () => {
		const { ai, calls } = recordingAi();
		const runner = createVoiceGatewayAi({
			ai: () => ai,
			gatewayId: () => "tedix-llm-production",
			channel: "voice-stt",
			attribution: () => null,
		});
		await runner.run("@cf/deepgram/flux", {}, { websocket: true });
		const metadata = metadataOf(calls[0]);
		expect(metadata.channel).toBe("voice-stt");
		expect(metadata.source).toBe("voice-stt");
		expect(JSON.parse(metadata.usage as string)).toEqual({
			k: "voice_stt",
			u: "units",
			q: 1,
		});
	});

	it("includes organization and session attribution from the call context", async () => {
		const { ai, calls } = recordingAi();
		const runner = createVoiceGatewayAi({
			ai: () => ai,
			gatewayId: () => "tedix-llm-production",
			channel: "voice-stt",
			attribution: () => ({
				organizationId: "org-123",
				sessionId: "kvoice-abc:conn:1",
			}),
		});
		await runner.run("@cf/deepgram/flux", {}, { websocket: true });
		const metadata = metadataOf(calls[0]);
		expect(metadata.orgId).toBe("org-123");
		expect(metadata.sessionId).toBe("kvoice-abc:conn:1");
	});

	it("omits attribution keys entirely when no call context is active", async () => {
		const { ai, calls } = recordingAi();
		const runner = createVoiceGatewayAi({
			ai: () => ai,
			gatewayId: () => "tedix-llm-production",
			channel: "voice-stt",
			attribution: () => null,
		});
		await runner.run("@cf/deepgram/flux", {}, { websocket: true });
		const metadata = metadataOf(calls[0]);
		expect("orgId" in metadata).toBe(false);
		expect("sessionId" in metadata).toBe(false);
	});

	it("resolves attribution lazily at inference time, not construction time", async () => {
		const { ai, calls } = recordingAi();
		let active: { organizationId: string } | null = null;
		const runner = createVoiceGatewayAi({
			ai: () => ai,
			gatewayId: () => "tedix-llm-production",
			channel: "voice-stt",
			attribution: () => active,
		});
		active = { organizationId: "org-later" };
		await runner.run("@cf/deepgram/flux", {}, { websocket: true });
		expect(metadataOf(calls[0]).orgId).toBe("org-later");
	});

	it("reports the provider result and Gateway log id to the direct usage observer", async () => {
		const { ai } = recordingAi();
		ai.aiGatewayLogId = "gateway-log-before";
		const baseRun = ai.run.bind(ai);
		ai.run = async (...args) => {
			const result = await baseRun(...args);
			ai.aiGatewayLogId = "gateway-log-123";
			return result;
		};
		const events: unknown[] = [];
		const runner = createVoiceGatewayAi({
			ai: () => ai,
			gatewayId: () => "tedix-llm-production",
			channel: "voice-stt",
			attribution: () => null,
			afterRun: (event) => events.push(event),
		});
		await runner.run("@cf/deepgram/flux", {}, { websocket: true });
		expect(events).toEqual([
			expect.objectContaining({
				channel: "voice-stt",
				model: "@cf/deepgram/flux",
				gatewayLogId: "gateway-log-123",
				result: { ok: true },
			}),
		]);
	});

	it("keeps a successful provider result when the observer fails and logs no speech", async () => {
		const { ai } = recordingAi();
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const runner = createVoiceGatewayAi({
			ai: () => ai,
			gatewayId: () => "tedix-llm-production",
			channel: "voice-stt",
			attribution: () => null,
			afterRun: () => {
				throw new Error("spoken content sk_live_secret", {
					cause: new TypeError("provider DSR=secret"),
				});
			},
		});
		await expect(
			runner.run("@cf/deepgram/flux", { text: "private" }),
		).resolves.toEqual({ ok: true });
		expect(log).toHaveBeenCalledWith({
			component: "kernel-voice",
			event: "voice.gateway_observer_failed",
			channel: "voice-stt",
			exception: { type: "Error", cause: { type: "TypeError" } },
		});
		expect(JSON.stringify(log.mock.calls)).not.toMatch(
			/spoken content|sk_live_secret|DSR=secret|stack/,
		);
		log.mockRestore();
	});
});

describe("createVoiceGatewayAi — voice-tts", () => {
	it("keeps TTS attributed as voice-tts with a character usage envelope", async () => {
		const { ai, calls } = recordingAi();
		const runner = createVoiceGatewayAi({
			ai: () => ai,
			gatewayId: () => "tedix-llm-production",
			channel: "voice-tts",
			attribution: () => ({ organizationId: "org-123" }),
		});
		await runner.run("@cf/some-tts", { text: "hello there" });
		const metadata = metadataOf(calls[0]);
		expect(metadata.channel).toBe("voice-tts");
		expect(metadata.source).toBe("voice-tts");
		expect(JSON.parse(metadata.usage as string)).toEqual({
			k: "voice_tts",
			u: "characters",
			q: 11,
		});
	});

	it("floors the character quantity at 1 for empty text", async () => {
		const { ai, calls } = recordingAi();
		const runner = createVoiceGatewayAi({
			ai: () => ai,
			gatewayId: () => "tedix-llm-production",
			channel: "voice-tts",
			attribution: () => null,
		});
		await runner.run("@cf/some-tts", { text: "" });
		expect(JSON.parse(metadataOf(calls[0]).usage as string).q).toBe(1);
	});
});

describe("createVoiceGatewayAi — option and metadata merging", () => {
	it("merges caller gateway options and metadata without overwriting them", async () => {
		const { ai, calls } = recordingAi();
		const runner = createVoiceGatewayAi({
			ai: () => ai,
			gatewayId: () => "tedix-llm-production",
			channel: "voice-stt",
			attribution: () => ({ organizationId: "org-123" }),
		});
		await runner.run(
			"@cf/deepgram/flux",
			{},
			{
				websocket: true,
				extraOption: "kept",
				gateway: {
					skipCache: true,
					metadata: { channel: "caller-channel", custom: "value" },
				},
			},
		);
		const options = calls[0].options ?? {};
		expect(options.websocket).toBe(true);
		expect(options.extraOption).toBe("kept");
		const gateway = gatewayOf(calls[0]);
		expect(gateway.skipCache).toBe(true);
		const metadata = metadataOf(calls[0]);
		// Caller metadata wins on collision and survives alongside our defaults.
		expect(metadata.channel).toBe("caller-channel");
		expect(metadata.custom).toBe("value");
		expect(metadata.source).toBe("voice-stt");
		expect(metadata.orgId).toBe("org-123");
	});

	it("enforces the configured gateway id over a caller-supplied one", async () => {
		const { ai, calls } = recordingAi();
		const runner = createVoiceGatewayAi({
			ai: () => ai,
			gatewayId: () => "tedix-llm-production",
			channel: "voice-stt",
			attribution: () => null,
		});
		await runner.run(
			"@cf/deepgram/flux",
			{},
			{ websocket: true, gateway: { id: "some-other-gateway" } },
		);
		expect(gatewayOf(calls[0]).id).toBe("tedix-llm-production");
	});
});

describe("createVoiceGatewayAi — fail-closed Gateway configuration", () => {
	it.each(["voice-stt", "voice-tts"] as const)(
		"throws for %s when the Gateway id is absent and never calls raw AI",
		async (channel) => {
			const { ai, calls } = recordingAi();
			const runner = createVoiceGatewayAi({
				ai: () => ai,
				gatewayId: () => undefined,
				channel,
				attribution: () => null,
			});
			await expect(async () =>
				runner.run("@cf/deepgram/flux", {}, { websocket: true }),
			).rejects.toThrow(/AI_GATEWAY_LLM_ID is not configured/);
			expect(calls).toHaveLength(0);
		},
	);

	it("treats a whitespace-only Gateway id as absent", async () => {
		const { ai, calls } = recordingAi();
		const runner = createVoiceGatewayAi({
			ai: () => ai,
			gatewayId: () => "   ",
			channel: "voice-stt",
			attribution: () => null,
		});
		await expect(async () =>
			runner.run("@cf/deepgram/flux", {}, { websocket: true }),
		).rejects.toThrow(/refusing raw Workers AI voice-stt inference/);
		expect(calls).toHaveLength(0);
	});
});
