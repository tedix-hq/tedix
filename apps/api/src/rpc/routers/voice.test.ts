import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";

const synthesizeSpeech = vi.hoisted(() => vi.fn());

vi.mock("@tedix/voice/tts", () => ({ synthesizeSpeech }));

import { voiceContractRouter } from "./voice";

function makeContext(): BaseContext {
	return {
		apiKey: {
			id: "api-key-1",
			name: "test",
			organizationId: "org-1",
			scopes: ["tedis:read"],
		},
		authType: "apikey",
		db: {} as BaseContext["db"],
		env: { ENVIRONMENT: "test" } as unknown as CloudflareEnv,
		headers: new Headers(),
		organizationId: "org-1",
		rateLimiter: {} as RateLimit,
		url: new URL("https://api.test/rpc"),
	};
}

describe("voice.synthesizeSpokenReply", () => {
	beforeEach(() => {
		synthesizeSpeech.mockReset();
	});

	it("synthesizes a kernel spoken reply through the shared TTS primitive", async () => {
		synthesizeSpeech.mockResolvedValue({
			audio: new Uint8Array([1, 2, 3]),
			mimeType: "audio/mpeg",
			provider: "workers-ai",
		});
		const context = makeContext();
		const client = createRouterClient(voiceContractRouter, {
			context,
		});

		const result = await client.synthesizeSpokenReply({
			subject: { type: "kernel" },
			text: "Hello kernel",
		});

		expect(synthesizeSpeech).toHaveBeenCalledWith(context.env, {
			text: "Hello kernel",
			voice: undefined,
		});
		expect(result).toEqual({
			audioBase64: "AQID",
			mimeType: "audio/mpeg",
			provider: "workers-ai",
		});
	});
});
