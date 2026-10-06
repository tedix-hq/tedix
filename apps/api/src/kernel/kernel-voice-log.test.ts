import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { logKernelVoiceEvent, logKernelVoiceFailure } from "./kernel-voice-log";

afterEach(() => vi.restoreAllMocks());

describe("kernel voice failure logging", () => {
	it("retains bounded cause topology without speech or credential content", () => {
		const error = new Error("spoken content sk_live_secret", {
			cause: new TypeError("DSR=refresh-secret"),
		});
		error.name = "arbitrary-secret-name";
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

		logKernelVoiceFailure("voice.call_failed", error, {
			connectionId: "connection-test",
		});

		expect(log).toHaveBeenCalledWith({
			component: "kernel-voice",
			event: "voice.call_failed",
			connectionId: "connection-test",
			exception: {
				type: "UnknownThrown",
				cause: { type: "TypeError" },
			},
		});
		expect(JSON.stringify(log.mock.calls)).not.toMatch(
			/spoken content|sk_live_secret|DSR=refresh-secret|arbitrary-secret-name|stack/,
		);
	});

	it("emits stable context-missing fields without an exception", () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		logKernelVoiceEvent("voice.call_context_missing", {
			stage: "turn",
			connectionId: "connection-test",
		});
		expect(log).toHaveBeenCalledWith({
			component: "kernel-voice",
			event: "voice.call_context_missing",
			stage: "turn",
			connectionId: "connection-test",
		});
	});
});
