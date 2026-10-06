import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { handleKernelVoiceTranscription } from "./voice-transcription-route";
import { mintKernelWsToken } from "./ws-token";
const transcribe = vi.hoisted(() => vi.fn());
vi.mock("@tedix/voice/stt", () => ({
	encodeBase64Audio: () => "audio-bytes",
	transcribeAudioAttachment: transcribe,
}));
const ORG = "11111111-2222-3333-4444-555555555555",
	KEY = "test-key";
const env = { PLATFORM_SERVICE_TOKEN: KEY } as CloudflareEnv;
const URL = "https://api.tedix.dev/kernel/voice/transcribe";
beforeEach(() => {
	vi.resetAllMocks();
	transcribe.mockResolvedValue({ text: "dictated text" });
});
async function upload(file?: File) {
	const { token } = await mintKernelWsToken({
		organizationId: ORG,
		descopeUserId: "user",
		platformServiceToken: KEY,
	});
	const form = new FormData();
	if (file) form.set("file", file);
	return new Request(URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"X-Kernel-Organization-Id": "spoofed",
		},
		body: form,
	});
}
describe("voice transcription", () => {
	it("authenticates before parsing or forwarding audio", async () => {
		expect(
			(
				await handleKernelVoiceTranscription(
					new Request(URL, { method: "POST", body: "invalid" }),
					env,
				)
			).status,
		).toBe(401);
		expect(transcribe).not.toHaveBeenCalled();
	});
	it("uses canonical authenticated organization for gateway metadata", async () => {
		const response = await handleKernelVoiceTranscription(
			await upload(new File(["audio"], "clip.webm", { type: "audio/webm" })),
			env,
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ text: "dictated text" });
		expect(transcribe).toHaveBeenCalledWith(
			env,
			expect.objectContaining({
				type: "audio",
				fileName: "clip.webm",
				mimeType: "audio/webm",
			}),
			{
				gatewayMetadata: { channel: "composer-dictation", organizationId: ORG },
			},
		);
	});
	it("rejects absent, empty and oversized audio", async () => {
		for (const file of [
			undefined,
			new File([], "empty.webm"),
			new File([new Uint8Array(25 * 1024 * 1024 + 1)], "large.webm"),
		]) {
			const response = await handleKernelVoiceTranscription(
				await upload(file),
				env,
			);
			expect(response.status).toBe(file?.size ? 413 : 400);
		}
		expect(transcribe).not.toHaveBeenCalled();
	});
	it("rejects malformed uploads after authentication", async () => {
		const request = await upload();
		request.headers.set("Content-Type", "text/plain");
		expect((await handleKernelVoiceTranscription(request, env)).status).toBe(
			400,
		);
		expect(transcribe).not.toHaveBeenCalled();
	});
	it("returns a bounded provider failure", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		transcribe.mockRejectedValueOnce(
			new Error("spoken content sk_live_secret", {
				cause: new TypeError("provider DSR=secret"),
			}),
		);
		expect(
			(
				await handleKernelVoiceTranscription(
					await upload(new File(["audio"], "clip.webm")),
					env,
				)
			).status,
		).toBe(502);
		expect(log).toHaveBeenCalledWith({
			component: "kernel-voice",
			event: "voice.transcription_failed",
			organizationId: ORG,
			exception: { type: "Error", cause: { type: "TypeError" } },
		});
		expect(JSON.stringify(log.mock.calls)).not.toMatch(
			/spoken content|sk_live_secret|DSR=secret|stack/,
		);
	});
});
