import { describe, expect, it, vi } from "vite-plus/test";
import {
	appendVoiceTranscript,
	dispatchVoiceComposerEvent,
	fetchVoiceInputToken,
	transcribeVoiceRecording,
} from "./use-composer-dictation";
import { VoiceSocketTransport } from "@tedix/chat-transport/voice-composer";

describe("composer dictation transport", () => {
	it("uses the shared transcript merge contract", () => {
		expect(appendVoiceTranscript("existing draft ", " new thought ")).toBe(
			"existing draft new thought",
		);
	});
	it("exposes content-free voice lifecycle events for operations", () => {
		const listener = vi.fn();
		window.addEventListener("tedix:voice", listener);
		dispatchVoiceComposerEvent({ name: "recording", durationMs: 42 });
		expect(listener).toHaveBeenCalledOnce();
		const received = listener.mock.calls[0]?.[0];
		if (!(received instanceof CustomEvent))
			throw new Error("Expected a CustomEvent");
		expect(received.detail).toEqual({
			name: "recording",
			durationMs: 42,
		});
		window.removeEventListener("tedix:voice", listener);
	});

	it("mints the short-lived socket token through the authenticated proxy", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({ token: "scoped-token" }),
		);
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			fetchVoiceInputToken("https://acme.os.tedix.dev/api"),
		).resolves.toBe("scoped-token");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://acme.os.tedix.dev/api/kernel/ws-token",
			{ credentials: "include" },
		);
		vi.unstubAllGlobals();
	});

	it("uploads transient audio with the scoped token and returns text", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(Response.json({ token: "scoped-token" }))
			.mockResolvedValueOnce(
				Response.json({ text: "Esta es una prueba.", provider: "azure" }),
			);
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			transcribeVoiceRecording(
				{
					blob: new Blob(["audio"], { type: "audio/webm" }),
					fileName: "dictation.webm",
					mimeType: "audio/webm",
				},
				"https://acme.os.tedix.dev/api",
			),
		).resolves.toBe("Esta es una prueba.");
		expect(fetchMock.mock.calls[1]?.[0]).toBe(
			"https://acme.os.tedix.dev/api/kernel/voice/transcribe",
		);
		expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
			method: "POST",
			headers: { Authorization: "Bearer scoped-token" },
		});
		vi.unstubAllGlobals();
	});

	it("forwards JSON and PCM only after the socket opens", () => {
		const sent: unknown[] = [];
		const sockets: FakeWebSocket[] = [];
		class FakeWebSocket {
			static OPEN = 1;
			readyState = 0;
			binaryType = "blob";
			onopen: (() => void) | null = null;
			onclose = null;
			onerror = null;
			onmessage = null;
			constructor(
				_url: string,
				readonly protocols?: string | string[],
			) {
				sockets.push(this);
			}
			send(value: unknown) {
				sent.push(value);
			}
			close() {}
		}
		vi.stubGlobal("WebSocket", FakeWebSocket);
		const transport = new VoiceSocketTransport(
			"wss://api.tedix.dev/kernel/voice/input",
			"bearer-scoped-token",
		);
		transport.connect();
		transport.sendJSON({ type: "start_call" });
		expect(sent).toEqual([]);
		const socket = sockets[0];
		if (!socket) throw new Error("socket was not created");
		expect(socket.protocols).toBe("bearer-scoped-token");
		socket.readyState = FakeWebSocket.OPEN;
		socket.onopen?.();
		transport.sendJSON({ type: "start_call" });
		const pcm = new ArrayBuffer(4);
		transport.sendBinary(pcm);
		expect(sent).toEqual(['{"type":"start_call"}', pcm]);
		vi.unstubAllGlobals();
	});
});
