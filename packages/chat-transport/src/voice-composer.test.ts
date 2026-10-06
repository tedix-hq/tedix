import { describe, expect, it, vi } from "vite-plus/test";
import {
	appendVoiceTranscript,
	createRecordedVoiceComposerController,
	VOICE_WAVE_BAR_COUNT,
	VOICE_WAVE_SAMPLE_INTERVAL_MS,
	voiceComposerErrorCode,
	voiceComposerErrorMessage,
	voiceWaveBarHeight,
} from "./voice-composer";

function recording() {
	return {
		blob: new Blob(["audio"]),
		fileName: "dictation.webm",
		mimeType: "audio/webm",
	};
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("shared voice composer", () => {
	it("provides one waveform and draft-merge model to every renderer", () => {
		expect(VOICE_WAVE_BAR_COUNT).toBe(96);
		expect(VOICE_WAVE_SAMPLE_INTERVAL_MS).toBe(100);
		expect(voiceWaveBarHeight(0)).toBe(4);
		expect(voiceWaveBarHeight(1)).toBeGreaterThan(4);
		expect(appendVoiceTranscript("existing draft ", " new thought ")).toBe(
			"existing draft new thought",
		);
	});

	it("records once and inserts an offline multilingual transcription on stop", async () => {
		const onTranscript = vi.fn();
		const stop = vi.fn(async () => ({
			blob: new Blob(["audio"], { type: "audio/webm" }),
			fileName: "dictation.webm",
			mimeType: "audio/webm",
		}));
		const transcribeRecording = vi.fn(
			async () => "Ni siquiera. La opción más barata.",
		);
		const controller = createRecordedVoiceComposerController({
			onTranscript,
			transcribeRecording,
			createRecorder: (onAudioLevel) => ({
				start: async () => onAudioLevel(0.49),
				stop,
				cancel: vi.fn(),
			}),
		});
		await controller.start();
		expect(controller.getSnapshot()).toMatchObject({
			phase: "recording",
			connected: true,
		});
		expect(controller.getSnapshot().audioHistory.at(-1)).toBe(0.49);
		controller.stop();
		expect(controller.getSnapshot().phase).toBe("transcribing");
		await vi.waitFor(() => expect(onTranscript).toHaveBeenCalled());
		expect(transcribeRecording).toHaveBeenCalledWith(
			expect.objectContaining({ fileName: "dictation.webm" }),
		);
		expect(onTranscript).toHaveBeenCalledWith(
			"Ni siquiera. La opción más barata.",
		);
		expect(controller.getSnapshot().phase).toBe("idle");
	});

	it("cancels the recorder and reports microphone permission failures", async () => {
		const cancel = vi.fn();
		const controller = createRecordedVoiceComposerController({
			onTranscript: vi.fn(),
			transcribeRecording: async () => "unused",
			createRecorder: () => ({
				start: async () => {
					throw new DOMException("Permission denied", "NotAllowedError");
				},
				stop: async () => recording(),
				cancel,
			}),
		});
		await expect(controller.start()).rejects.toThrow("Permission denied");
		expect(cancel).toHaveBeenCalledOnce();
		expect(controller.getSnapshot()).toMatchObject({
			phase: "idle",
			connected: false,
			errorCode: "permission_denied",
			error:
				"Microphone access is blocked. Allow access in your browser settings, then try again.",
		});
		expect(voiceComposerErrorCode(new DOMException("", "NotFoundError"))).toBe(
			"device_unavailable",
		);
		expect(voiceComposerErrorMessage("device_busy")).toContain("another app");
	});
	it("keeps a rolling amplitude history", async () => {
		let sample!: (value: number) => void;
		const controller = createRecordedVoiceComposerController({
			onTranscript: vi.fn(),
			transcribeRecording: async () => "unused",
			createRecorder: (onAudioLevel) => {
				sample = onAudioLevel;
				return {
					start: async () => {},
					stop: async () => recording(),
					cancel: vi.fn(),
				};
			},
		});
		await controller.start();
		sample(0.04);
		sample(0.64);
		expect(controller.getSnapshot().audioHistory).toHaveLength(
			VOICE_WAVE_BAR_COUNT,
		);
		expect(controller.getSnapshot().audioHistory.slice(-3)).toEqual([
			0, 0.04, 0.64,
		]);
		controller.dispose();
	});
	it("does not publish recording after cancellation during recorder start", async () => {
		const ready = deferred<void>();
		const cancel = vi.fn();
		const events: string[] = [];
		const controller = createRecordedVoiceComposerController({
			onTranscript: vi.fn(),
			transcribeRecording: async () => "unused",
			onEvent: (e) => events.push(e.name),
			createRecorder: () => ({
				start: () => ready.promise,
				stop: async () => recording(),
				cancel,
			}),
		});
		const starting = controller.start();
		controller.cancel();
		ready.resolve();
		await starting;
		expect(cancel).toHaveBeenCalledOnce();
		expect(controller.getSnapshot().phase).toBe("idle");
		expect(events).not.toContain("recording");
	});
	it("suppresses a late transcription after cancellation", async () => {
		const result = deferred<string>();
		const onTranscript = vi.fn();
		const transcribe = vi.fn(() => result.promise);
		const controller = createRecordedVoiceComposerController({
			onTranscript,
			transcribeRecording: transcribe,
			createRecorder: () => ({
				start: async () => {},
				stop: async () => recording(),
				cancel: vi.fn(),
			}),
		});
		await controller.start();
		controller.stop();
		await vi.waitFor(() => expect(transcribe).toHaveBeenCalled());
		controller.cancel();
		result.resolve("discard me");
		await result.promise;
		await Promise.resolve();
		expect(onTranscript).not.toHaveBeenCalled();
		expect(controller.getSnapshot().phase).toBe("idle");
	});
	it("times out, retries, and suppresses the prior late result", async () => {
		vi.useFakeTimers();
		try {
			const old = deferred<string>();
			const onTranscript = vi.fn();
			const transcribe = vi
				.fn()
				.mockImplementationOnce(() => old.promise)
				.mockResolvedValueOnce("new result");
			const controller = createRecordedVoiceComposerController({
				onTranscript,
				transcribeRecording: transcribe,
				transcriptionTimeoutMs: 50,
				createRecorder: () => ({
					start: async () => {},
					stop: async () => recording(),
					cancel: vi.fn(),
				}),
			});
			await controller.start();
			controller.stop();
			await vi.advanceTimersByTimeAsync(50);
			expect(controller.getSnapshot()).toMatchObject({
				errorCode: "transcription_timeout",
				phase: "idle",
			});
			await controller.start();
			expect(controller.getSnapshot()).toMatchObject({
				error: null,
				errorCode: null,
				phase: "recording",
			});
			old.resolve("stale result");
			await vi.advanceTimersByTimeAsync(0);
			expect(onTranscript).not.toHaveBeenCalled();
			controller.stop();
			await vi.advanceTimersByTimeAsync(0);
			expect(onTranscript).toHaveBeenCalledExactlyOnceWith("new result");
			expect(controller.getSnapshot().phase).toBe("idle");
			controller.dispose();
		} finally {
			vi.useRealTimers();
		}
	});
	it("emits content-free lifecycle telemetry with nonnegative durations", async () => {
		const events: Array<{ name: string; durationMs: number }> = [];
		const onTranscript = vi.fn();
		const controller = createRecordedVoiceComposerController({
			onTranscript,
			transcribeRecording: async () => "private words",
			onEvent: (e) => events.push(e),
			createRecorder: () => ({
				start: async () => {},
				stop: async () => recording(),
				cancel: vi.fn(),
			}),
		});
		await controller.start();
		controller.stop();
		await vi.waitFor(() => expect(onTranscript).toHaveBeenCalled());
		expect(events.map((e) => e.name)).toEqual([
			"connecting",
			"recording",
			"transcribing",
			"transcript_received",
		]);
		expect(
			events.every((e) => Number.isFinite(e.durationMs) && e.durationMs >= 0),
		).toBe(true);
		expect(JSON.stringify(events)).not.toContain("private words");
		controller.dispose();
	});
});
