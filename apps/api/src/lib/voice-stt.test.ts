import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	type AudioAttachment,
	buildFailedTranscriptContent,
	buildTranscriptContent,
	decodeBase64Audio,
	hasAiGateway,
	hasAzureStt,
	MAX_AUDIO_BYTES,
	SttError,
	transcribeAudioAttachment,
	type VoiceSttEnv,
} from "@tedix/voice/stt";

// "SGVsbG8=" decodes to "Hello" (5 bytes) — a valid non-empty payload.
const HELLO_WAV_B64 = "SGVsbG8=";

function audioAttachment(
	overrides: Partial<AudioAttachment> = {},
): AudioAttachment {
	return {
		content: HELLO_WAV_B64,
		fileName: "voice.wav",
		mimeType: "audio/wav",
		type: "audio",
		...overrides,
	};
}

/** Stub Workers AI binding returning a fixed transcript. */
function stubAi(text: string, capture?: (call: unknown) => void): Ai {
	return {
		run: vi.fn(async (model: unknown, input: unknown, options?: unknown) => {
			capture?.({ model, input, options });
			return { text };
		}),
	} as unknown as Ai;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("decodeBase64Audio", () => {
	it("decodes plain base64", () => {
		expect(Array.from(decodeBase64Audio(HELLO_WAV_B64))).toEqual([
			72, 101, 108, 108, 111,
		]);
	});

	it("strips a data: URL prefix", () => {
		const bytes = decodeBase64Audio(`data:audio/wav;base64,${HELLO_WAV_B64}`);
		expect(Array.from(bytes)).toEqual([72, 101, 108, 108, 111]);
	});
});

describe("hasAzureStt / hasAiGateway", () => {
	it("prefers Azure when authenticated Gateway BYOK is configured", () => {
		const env: VoiceSttEnv = {
			AI: stubAi("x"),
			AZURE_OPENAI_RESOURCE: "r",
			AI_GATEWAY_ACCOUNT_ID: "a",
			AI_GATEWAY_LLM_ID: "g",
			CF_AI_GATEWAY_TOKEN: "token",
		};
		expect(hasAzureStt(env)).toBe(true);
	});

	it("falls back to Workers AI when Azure creds missing", () => {
		const env: VoiceSttEnv = { AI: stubAi("x") };
		expect(hasAzureStt(env)).toBe(false);
	});

	it("requires BOTH gateway vars", () => {
		expect(hasAiGateway({ AI: stubAi("x"), AI_GATEWAY_ACCOUNT_ID: "a" })).toBe(
			false,
		);
		expect(hasAiGateway({ AI: stubAi("x"), AI_GATEWAY_LLM_ID: "g" })).toBe(
			false,
		);
		expect(
			hasAiGateway({
				AI: stubAi("x"),
				AI_GATEWAY_ACCOUNT_ID: "a",
				AI_GATEWAY_LLM_ID: "g",
			}),
		).toBe(true);
	});
});

describe("transcribeAudioAttachment — validation", () => {
	it("rejects non-audio attachments", async () => {
		const env: VoiceSttEnv = { AI: stubAi("x") };
		await expect(
			transcribeAudioAttachment(env, audioAttachment({ type: "file" })),
		).rejects.toBeInstanceOf(SttError);
	});

	it("rejects empty audio", async () => {
		const env: VoiceSttEnv = { AI: stubAi("x") };
		await expect(
			transcribeAudioAttachment(env, audioAttachment({ content: "" })),
		).rejects.toBeInstanceOf(SttError);
	});

	it("rejects obviously non-audio mime types", async () => {
		const env: VoiceSttEnv = { AI: stubAi("x") };
		await expect(
			transcribeAudioAttachment(
				env,
				audioAttachment({ mimeType: "application/pdf" }),
			),
		).rejects.toBeInstanceOf(SttError);
	});

	it("rejects payloads over the size cap", async () => {
		const env: VoiceSttEnv = { AI: stubAi("x") };
		// base64 expands ~4/3; build a string that decodes past MAX_AUDIO_BYTES.
		const big = "A".repeat(Math.ceil((MAX_AUDIO_BYTES + 4) * 1.4));
		await expect(
			transcribeAudioAttachment(env, audioAttachment({ content: big })),
		).rejects.toBeInstanceOf(SttError);
	});
});

describe("transcribeAudioAttachment — Workers AI fallback", () => {
	it("transcribes via the AI binding when Azure creds are absent", async () => {
		let seen: { model?: unknown; input?: unknown; options?: unknown } = {};
		const env: VoiceSttEnv = {
			AI: stubAi("hello from whisper", (c) => {
				seen = c as typeof seen;
			}),
		};
		const result = await transcribeAudioAttachment(env, audioAttachment());
		expect(result).toEqual({
			text: "hello from whisper",
			provider: "workers-ai",
		});
		expect(seen.model).toBe("@cf/openai/whisper");
		expect((seen.input as { audio: number[] }).audio).toEqual([
			72, 101, 108, 108, 111,
		]);
		// No gateway configured → no gateway option.
		expect(seen.options).toBeUndefined();
	});

	it("passes the gateway id to the AI binding when configured", async () => {
		let seen: { options?: unknown } = {};
		const env: VoiceSttEnv = {
			AI: stubAi("ok", (c) => {
				seen = c as typeof seen;
			}),
			AI_GATEWAY_ACCOUNT_ID: "acct",
			AI_GATEWAY_LLM_ID: "gw",
		};
		await transcribeAudioAttachment(env, audioAttachment(), {
			gatewayMetadata: {
				orgId: "org-1",
				source: "voice-stt",
				usage: '{"k":"voice_stt","u":"units","q":1}',
			},
		});
		expect(seen.options).toEqual({
			gateway: {
				id: "gw",
				metadata: {
					channel: "voice-stt",
					orgId: "org-1",
					source: "voice-stt",
					usage: '{"k":"voice_stt","u":"units","q":1}',
				},
			},
		});
	});
});

describe("transcribeAudioAttachment — Azure provider", () => {
	it("hits the Azure deployment URL and returns the transcript", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ text: "azure transcript" }), {
				status: 200,
			}),
		);
		const env: VoiceSttEnv = {
			AI: stubAi("unused"),
			AZURE_OPENAI_RESOURCE: "myresource",
			AZURE_OPENAI_STT_DEPLOYMENT: "gpt-transcribe",
			AZURE_OPENAI_STT_API_VERSION: "2025-01-01-preview",
			AI_GATEWAY_ACCOUNT_ID: "acct123",
			AI_GATEWAY_LLM_ID: "tedix-llm-production",
			CF_AI_GATEWAY_TOKEN: "gateway-token",
		};
		const result = await transcribeAudioAttachment(env, audioAttachment(), {
			gatewayMetadata: { orgId: "org-1", source: "voice-stt" },
		});
		expect(result).toEqual({ text: "azure transcript", provider: "azure" });
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(
			"https://gateway.ai.cloudflare.com/v1/acct123/tedix-llm-production/azure-openai/myresource/gpt-transcribe/audio/transcriptions?api-version=2025-01-01-preview",
		);
		expect((init.headers as Record<string, string>)["api-key"]).toBeUndefined();
		expect(
			(init.headers as Record<string, string>)["cf-aig-authorization"],
		).toBe("Bearer gateway-token");
		expect(
			JSON.parse(
				(init.headers as Record<string, string>)["cf-aig-metadata"] ?? "{}",
			),
		).toEqual({
			channel: "voice-stt",
			orgId: "org-1",
			source: "voice-stt",
		});
		expect(init.body).toBeInstanceOf(FormData);
	});

	it("routes through AI Gateway when both gateway vars are set", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ text: "via gateway" }), {
				status: 200,
			}),
		);
		const env: VoiceSttEnv = {
			AI: stubAi("unused"),
			AZURE_OPENAI_RESOURCE: "myresource",
			AI_GATEWAY_ACCOUNT_ID: "acct123",
			AI_GATEWAY_LLM_ID: "voice-gw",
			CF_AI_GATEWAY_TOKEN: "token",
		};
		await transcribeAudioAttachment(env, audioAttachment());
		const [url] = fetchMock.mock.calls[0] as [string];
		expect(url).toBe(
			"https://gateway.ai.cloudflare.com/v1/acct123/voice-gw/azure-openai/myresource/gpt-transcribe/audio/transcriptions?api-version=2025-01-01-preview",
		);
	});

	it("rides the Workers AI binding when azure-openai is allowlisted in-account", async () => {
		const globalFetch = vi.spyOn(globalThis, "fetch");
		const bindingFetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ text: "via binding" }), { status: 200 }),
		);
		const env: VoiceSttEnv = {
			AI: { run: vi.fn(), fetch: bindingFetch } as unknown as Ai,
			AZURE_OPENAI_RESOURCE: "myresource",
			AI_GATEWAY_ACCOUNT_ID: "acct123",
			AI_GATEWAY_LLM_ID: "voice-gw",
			AI_GATEWAY_BINDING_PROVIDERS: "azure-openai",
		};
		const result = await transcribeAudioAttachment(env, audioAttachment());
		expect(result).toEqual({ text: "via binding", provider: "azure" });
		expect(globalFetch).not.toHaveBeenCalled();
		const [url, init] = bindingFetch.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(
			"https://workers-binding.ai/ai-gateway/gateways/voice-gw/azure-openai/myresource/gpt-transcribe/audio/transcriptions?api-version=2025-01-01-preview",
		);
		expect(
			(init.headers as Record<string, string>)["cf-aig-authorization"],
		).toBe("Bearer cloudflare-gateway-binding");
		// The multipart body is handed to the binding untouched.
		expect(init.body).toBeInstanceOf(FormData);
	});

	it("falls back to Workers AI when Azure returns a non-2xx", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("DeploymentNotFound", { status: 404 }),
		);
		const env: VoiceSttEnv = {
			AI: stubAi("whisper rescued it"),
			AZURE_OPENAI_RESOURCE: "r",
			AI_GATEWAY_ACCOUNT_ID: "acct",
			AI_GATEWAY_LLM_ID: "gateway",
			CF_AI_GATEWAY_TOKEN: "token",
		};
		const result = await transcribeAudioAttachment(env, audioAttachment());
		expect(result).toEqual({
			text: "whisper rescued it",
			provider: "workers-ai",
		});
	});

	it("falls back to Workers AI when the Azure request errors/times out", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
		const env: VoiceSttEnv = {
			AI: stubAi("whisper fallback"),
			AZURE_OPENAI_RESOURCE: "r",
			AI_GATEWAY_ACCOUNT_ID: "acct",
			AI_GATEWAY_LLM_ID: "gateway",
			CF_AI_GATEWAY_TOKEN: "token",
		};
		const result = await transcribeAudioAttachment(env, audioAttachment());
		expect(result).toEqual({
			text: "whisper fallback",
			provider: "workers-ai",
		});
	});

	it("throws SttError when Azure fails AND Workers AI also fails", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("DeploymentNotFound", { status: 404 }),
		);
		// AI binding returns no `text` → whisper throws SttError too.
		const failingAi = {
			run: vi.fn(async () => ({})),
		} as unknown as Ai;
		const env: VoiceSttEnv = {
			AI: failingAi,
			AZURE_OPENAI_RESOURCE: "r",
			AI_GATEWAY_ACCOUNT_ID: "acct",
			AI_GATEWAY_LLM_ID: "gateway",
			CF_AI_GATEWAY_TOKEN: "token",
		};
		await expect(
			transcribeAudioAttachment(env, audioAttachment()),
		).rejects.toBeInstanceOf(SttError);
	});
});

describe("transcript injection (isolate branch templating)", () => {
	it("templates transcript when there is no user text", () => {
		expect(buildTranscriptContent("", "remind me to call Bob")).toBe(
			"[Voice message transcript]\nremind me to call Bob",
		);
	});

	it("keeps user-typed text above the transcript", () => {
		expect(buildTranscriptContent("here is my note:", "buy milk")).toBe(
			"here is my note:\n\n[Voice message transcript]\nbuy milk",
		);
	});

	it("marks a successful-but-silent transcript distinctly from a failure", () => {
		expect(buildTranscriptContent("", "   ")).toBe(
			"[Voice message transcript]\n(no speech detected)",
		);
	});

	it("fail-soft content embeds the failure reason and keeps user text", () => {
		expect(buildFailedTranscriptContent("hi", "Azure STT failed (404)")).toBe(
			"hi\n\n[audio transcription failed: Azure STT failed (404)]",
		);
		expect(buildFailedTranscriptContent("", "no provider")).toBe(
			"[audio transcription failed: no provider]",
		);
	});
});
