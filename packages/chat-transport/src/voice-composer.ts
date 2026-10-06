import type {
	VoiceTransport,
	VoiceTransportCloseInfo,
} from "@cloudflare/voice/client";

export const VOICE_WAVE_BAR_COUNT = 96;
/**
 * Advance the visible waveform at 10Hz, independent of display refresh rate.
 * At 96 bars this keeps almost ten seconds of speaking visible instead of
 * replacing the complete history every ~1.6 seconds on a 60Hz display.
 */
export const VOICE_WAVE_SAMPLE_INTERVAL_MS = 100;
export const VOICE_TRANSCRIPTION_TIMEOUT_MS = 15_000;

export type VoiceComposerErrorCode =
	| "permission_denied"
	| "device_unavailable"
	| "device_busy"
	| "connection_timeout"
	| "transcription_timeout"
	| "empty_transcript"
	| "service_unavailable";

export type VoiceComposerEventName =
	| "connecting"
	| "recording"
	| "transcribing"
	| "transcript_received"
	| "cancelled"
	| "failed";

export interface VoiceComposerEvent {
	name: VoiceComposerEventName;
	durationMs: number;
	errorCode?: VoiceComposerErrorCode;
}

export type VoiceComposerPhase =
	| "idle"
	| "connecting"
	| "recording"
	| "transcribing";

export interface VoiceComposerSnapshot {
	audioLevel: number;
	audioHistory: number[];
	connected: boolean;
	error: string | null;
	errorCode: VoiceComposerErrorCode | null;
	interimTranscript: string | null;
	phase: VoiceComposerPhase;
}

export interface VoiceRecording {
	blob: Blob;
	fileName: string;
	mimeType: string;
}

export interface RecordedVoiceComposerOptions {
	onTranscript: (text: string) => void;
	transcribeRecording: (recording: VoiceRecording) => Promise<string>;
	onEvent?: (event: VoiceComposerEvent) => void;
	transcriptionTimeoutMs?: number;
	createRecorder?: (onAudioLevel: (level: number) => void) => VoiceRecorderLike;
}

export interface VoiceRecorderLike {
	start(): Promise<void>;
	stop(): Promise<VoiceRecording>;
	cancel(): void;
}

function preferredRecordingMimeType(): string | undefined {
	for (const mime of ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"]) {
		if (MediaRecorder.isTypeSupported(mime)) return mime;
	}
	return undefined;
}

export function createBrowserVoiceRecorder(
	onAudioLevel: (level: number) => void,
): VoiceRecorderLike {
	let stream: MediaStream | null = null;
	let recorder: MediaRecorder | null = null;
	let context: AudioContext | null = null;
	let animationFrame = 0;
	let cancelled = false;
	const chunks: Blob[] = [];
	const cleanup = () => {
		if (animationFrame) cancelAnimationFrame(animationFrame);
		animationFrame = 0;
		stream?.getTracks().forEach((track) => track.stop());
		stream = null;
		void context?.close();
		context = null;
		onAudioLevel(0);
	};
	return {
		async start() {
			cancelled = false;
			stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			const mimeType = preferredRecordingMimeType();
			recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
			recorder.ondataavailable = (event) => {
				if (event.data.size > 0) chunks.push(event.data);
			};
			context = new AudioContext();
			const analyser = context.createAnalyser();
			analyser.fftSize = 256;
			analyser.smoothingTimeConstant = 0.84;
			context.createMediaStreamSource(stream).connect(analyser);
			const samples = new Uint8Array(analyser.fftSize);
			let lastWaveSampleAt = Number.NEGATIVE_INFINITY;
			const measure = (frameTimestamp: number) => {
				analyser.getByteTimeDomainData(samples);
				if (
					frameTimestamp - lastWaveSampleAt >=
					VOICE_WAVE_SAMPLE_INTERVAL_MS
				) {
					let energy = 0;
					for (const sample of samples) {
						const centered = (sample - 128) / 128;
						energy += centered * centered;
					}
					lastWaveSampleAt = frameTimestamp;
					onAudioLevel(Math.sqrt(energy / samples.length));
				}
				animationFrame = requestAnimationFrame(measure);
			};
			measure(performance.now());
			recorder.start(250);
		},
		stop() {
			return new Promise<VoiceRecording>((resolve, reject) => {
				if (!recorder || recorder.state === "inactive") {
					cleanup();
					reject(new Error("No voice recording is active"));
					return;
				}
				recorder.onerror = () => {
					cleanup();
					reject(new Error("Voice recording failed"));
				};
				recorder.onstop = () => {
					const mimeType =
						recorder?.mimeType || chunks[0]?.type || "audio/webm";
					const extension = mimeType.startsWith("audio/mp4") ? "m4a" : "webm";
					const blob = new Blob(chunks, { type: mimeType });
					cleanup();
					if (!cancelled)
						resolve({ blob, fileName: `dictation.${extension}`, mimeType });
				};
				recorder.stop();
			});
		},
		cancel() {
			cancelled = true;
			if (recorder?.state !== "inactive") recorder?.stop();
			cleanup();
		},
	};
}

/** Shared native + embedded controller for transient, file-based dictation. */
export function createRecordedVoiceComposerController(
	options: RecordedVoiceComposerOptions,
) {
	let recorder: VoiceRecorderLike | null = null;
	let disposed = false;
	let operationId = 0;
	let startedAt = Date.now();
	let timeout: ReturnType<typeof setTimeout> | null = null;
	let state: VoiceComposerSnapshot = {
		audioLevel: 0,
		audioHistory: Array.from({ length: VOICE_WAVE_BAR_COUNT }, () => 0),
		connected: false,
		error: null,
		errorCode: null,
		interimTranscript: null,
		phase: "idle",
	};
	const listeners = new Set<(snapshot: VoiceComposerSnapshot) => void>();
	const publish = (patch: Partial<VoiceComposerSnapshot>) => {
		state = { ...state, ...patch };
		for (const listener of listeners) listener(state);
	};
	const emit = (
		name: VoiceComposerEventName,
		errorCode?: VoiceComposerErrorCode,
	) =>
		options.onEvent?.({
			name,
			durationMs: Math.max(0, Date.now() - startedAt),
			...(errorCode ? { errorCode } : {}),
		});
	const clearTimeoutIfNeeded = () => {
		if (timeout) clearTimeout(timeout);
		timeout = null;
	};
	const reset = (
		error: string | null = null,
		errorCode: VoiceComposerErrorCode | null = null,
	) => {
		clearTimeoutIfNeeded();
		publish({
			audioLevel: 0,
			audioHistory: Array.from({ length: VOICE_WAVE_BAR_COUNT }, () => 0),
			connected: false,
			error,
			errorCode,
			interimTranscript: null,
			phase: "idle",
		});
	};
	const fail = (reason: unknown) => {
		const code = voiceComposerErrorCode(reason);
		reset(voiceComposerErrorMessage(code), code);
		emit("failed", code);
	};
	return {
		getSnapshot: () => state,
		subscribe(listener: (snapshot: VoiceComposerSnapshot) => void) {
			listeners.add(listener);
			listener(state);
			return () => listeners.delete(listener);
		},
		async start() {
			const currentOperation = ++operationId;
			startedAt = Date.now();
			publish({ error: null, errorCode: null, phase: "connecting" });
			emit("connecting");
			recorder = (options.createRecorder ?? createBrowserVoiceRecorder)(
				(value) =>
					publish({
						audioLevel: value,
						audioHistory: [
							...state.audioHistory.slice(-(VOICE_WAVE_BAR_COUNT - 1)),
							Math.max(0, Number(value) || 0),
						],
					}),
			);
			try {
				await recorder.start();
				if (disposed || operationId !== currentOperation) return;
				publish({ connected: true, phase: "recording" });
				emit("recording");
			} catch (reason) {
				recorder?.cancel();
				recorder = null;
				fail(reason);
				throw reason;
			}
		},
		stop() {
			if (!recorder || state.phase !== "recording") return;
			const currentOperation = operationId;
			const activeRecorder = recorder;
			recorder = null;
			publish({ connected: false, phase: "transcribing" });
			emit("transcribing");
			timeout = setTimeout(() => {
				if (state.phase !== "transcribing") return;
				operationId += 1;
				fail(failure("transcription_timeout"));
			}, options.transcriptionTimeoutMs ?? VOICE_TRANSCRIPTION_TIMEOUT_MS);
			void activeRecorder
				.stop()
				.then(options.transcribeRecording)
				.then((text) => {
					if (disposed || operationId !== currentOperation) return;
					const transcript = text.trim();
					if (!transcript) throw failure("empty_transcript");
					options.onTranscript(transcript);
					emit("transcript_received");
					reset();
				})
				.catch((reason) => {
					if (!disposed && operationId === currentOperation) fail(reason);
				});
		},
		cancel() {
			operationId += 1;
			recorder?.cancel();
			recorder = null;
			reset();
			emit("cancelled");
		},
		dispose() {
			disposed = true;
			operationId += 1;
			recorder?.cancel();
			recorder = null;
			clearTimeoutIfNeeded();
			listeners.clear();
		},
	};
}

export class VoiceSocketTransport implements VoiceTransport {
	#socket: WebSocket | null = null;
	#reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	#shouldReconnect = false;
	readonly #url: string;
	readonly #protocols?: string | string[];
	readonly #reconnect: boolean;

	onopen: (() => void) | null = null;
	onclose: ((info?: VoiceTransportCloseInfo) => void) | null = null;
	onerror: ((error?: unknown) => void) | null = null;
	onmessage: ((data: string | ArrayBuffer | Blob) => void) | null = null;

	constructor(
		url: string,
		protocols?: string | string[],
		options: { reconnect?: boolean } = {},
	) {
		this.#url = url;
		this.#protocols = protocols;
		this.#reconnect = options.reconnect ?? false;
	}

	get connected(): boolean {
		return this.#socket?.readyState === WebSocket.OPEN;
	}

	connect(): void {
		this.#shouldReconnect = true;
		if (this.#socket || this.#reconnectTimer) return;
		const socket = new WebSocket(this.#url, this.#protocols);
		socket.binaryType = "arraybuffer";
		socket.onopen = () => this.onopen?.();
		socket.onerror = (event) => this.onerror?.(event);
		socket.onmessage = (event) => this.onmessage?.(event.data);
		socket.onclose = (event) => {
			this.#socket = null;
			this.onclose?.({
				code: event.code,
				reason: event.reason,
				wasClean: event.wasClean,
			});
			if (this.#shouldReconnect && this.#reconnect) {
				this.#reconnectTimer = setTimeout(() => {
					this.#reconnectTimer = null;
					this.connect();
				}, 1_000);
			}
		};
		this.#socket = socket;
	}

	disconnect(): void {
		this.#shouldReconnect = false;
		if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
		this.#reconnectTimer = null;
		this.#socket?.close();
		this.#socket = null;
	}

	sendJSON(data: Record<string, unknown>): void {
		if (this.connected) this.#socket?.send(JSON.stringify(data));
	}

	sendBinary(data: ArrayBuffer): void {
		if (this.connected) this.#socket?.send(data);
	}
}

export function voiceWebSocketUrl(baseUrl: string, pathname: string): string {
	const url = new URL(baseUrl);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.pathname = pathname;
	url.search = "";
	url.hash = "";
	return url.href;
}

export function voiceWaveBarHeight(audioLevel: number): number {
	const strength = Math.min(
		1,
		Math.sqrt(Math.max(0, Number(audioLevel) || 0)) * 1.35,
	);
	return 4 + strength * 28;
}

export function appendVoiceTranscript(
	draft: string,
	transcript: string,
): string {
	return [draft.trim(), transcript.trim()].filter(Boolean).join(" ");
}

const failure = (code: VoiceComposerErrorCode) =>
	Object.assign(new Error(code), { voiceComposerErrorCode: code });

export function voiceComposerErrorCode(value: unknown): VoiceComposerErrorCode {
	const explicit = (value as { voiceComposerErrorCode?: unknown } | null)
		?.voiceComposerErrorCode;
	if (typeof explicit === "string") return explicit as VoiceComposerErrorCode;
	const name = value instanceof Error ? value.name.toLowerCase() : "";
	const message =
		value instanceof Error
			? value.message.toLowerCase()
			: typeof value === "string"
				? value.toLowerCase()
				: "";
	if (
		name === "notallowederror" ||
		name === "securityerror" ||
		/permission|not allowed|denied|blocked/.test(message)
	)
		return "permission_denied";
	if (
		name === "notfounderror" ||
		/no microphone|no device|not found/.test(message)
	)
		return "device_unavailable";
	if (
		name === "notreadableerror" ||
		name === "aborterror" ||
		/in use|busy|could not start audio/.test(message)
	)
		return "device_busy";
	if (/connection.*timed out|connect.*timeout/.test(message))
		return "connection_timeout";
	if (/no speech|empty transcript|nothing to transcribe/.test(message))
		return "empty_transcript";
	return "service_unavailable";
}

export function voiceComposerErrorMessage(
	code: VoiceComposerErrorCode,
): string {
	if (code === "permission_denied")
		return "Microphone access is blocked. Allow access in your browser settings, then try again.";
	if (code === "device_unavailable")
		return "No microphone is available. Connect or enable one, then try again.";
	if (code === "device_busy")
		return "The microphone is in use by another app. Release it there, then try again.";
	if (code === "connection_timeout")
		return "The microphone connection timed out. Try again.";
	if (code === "transcription_timeout")
		return "Transcription took too long. Try again.";
	if (code === "empty_transcript")
		return "No speech was detected. Try speaking again.";
	return "Voice input is temporarily unavailable. Try again.";
}
