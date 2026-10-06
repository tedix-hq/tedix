import {
	appendVoiceTranscript,
	createRecordedVoiceComposerController,
	type VoiceComposerEvent,
	type VoiceRecording,
	type VoiceComposerSnapshot,
	VOICE_WAVE_BAR_COUNT,
} from "@tedix/chat-transport/voice-composer";
import { useCallback, useEffect, useRef, useState } from "react";

export { appendVoiceTranscript };

export interface ComposerDictationState extends VoiceComposerSnapshot {
	cancel: () => void;
	start: () => Promise<void>;
	stop: () => void;
}

interface KernelWsTokenResponse {
	token: string;
}

export async function fetchVoiceInputToken(
	apiUrl = `${window.location.origin}/api`,
): Promise<string> {
	const response = await fetch(`${apiUrl.replace(/\/$/, "")}/kernel/ws-token`, {
		credentials: "include",
	});
	if (!response.ok) throw new Error("Voice input is unavailable");
	const payload = (await response.json()) as KernelWsTokenResponse;
	if (!payload.token) throw new Error("Voice input is unavailable");
	return payload.token;
}

export async function transcribeVoiceRecording(
	recording: VoiceRecording,
	apiUrl = `${window.location.origin}/api`,
): Promise<string> {
	const token = await fetchVoiceInputToken(apiUrl);
	const body = new FormData();
	body.append("file", recording.blob, recording.fileName);
	const response = await fetch(
		`${apiUrl.replace(/\/$/, "")}/kernel/voice/transcribe`,
		{
			method: "POST",
			credentials: "include",
			headers: { Authorization: `Bearer ${token}` },
			body,
		},
	);
	if (!response.ok) throw new Error("Voice transcription failed");
	const payload = (await response.json()) as { text?: unknown };
	if (typeof payload.text !== "string" || !payload.text.trim())
		throw new Error("No speech was detected");
	return payload.text;
}

const INITIAL_STATE: VoiceComposerSnapshot = {
	audioLevel: 0,
	audioHistory: Array.from({ length: VOICE_WAVE_BAR_COUNT }, () => 0),
	connected: false,
	error: null,
	errorCode: null,
	interimTranscript: null,
	phase: "idle",
};

export function dispatchVoiceComposerEvent(event: VoiceComposerEvent): void {
	if (typeof window === "undefined") return;
	window.dispatchEvent(new CustomEvent("tedix:voice", { detail: event }));
}

export function useComposerDictation(
	onTranscript: (text: string) => void,
): ComposerDictationState {
	const callbackRef = useRef(onTranscript);
	callbackRef.current = onTranscript;
	const controllerRef = useRef<ReturnType<
		typeof createRecordedVoiceComposerController
	> | null>(null);
	const [state, setState] = useState<VoiceComposerSnapshot>(INITIAL_STATE);

	useEffect(() => {
		const controller = createRecordedVoiceComposerController({
			onTranscript: (text) => callbackRef.current(text),
			onEvent: dispatchVoiceComposerEvent,
			transcribeRecording: transcribeVoiceRecording,
			transcriptionTimeoutMs: 30_000,
		});
		controllerRef.current = controller;
		const unsubscribe = controller.subscribe(setState);
		return () => {
			unsubscribe();
			controller.dispose();
			controllerRef.current = null;
		};
	}, []);

	const start = useCallback(
		async () => controllerRef.current?.start(),
		[],
	) as () => Promise<void>;
	const stop = useCallback(() => controllerRef.current?.stop(), []);
	const cancel = useCallback(() => controllerRef.current?.cancel(), []);

	return { ...state, cancel, start, stop };
}
