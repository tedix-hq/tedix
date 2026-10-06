import type {
	Transcriber,
	TranscriberSession,
	TranscriberSessionOptions,
} from "@cloudflare/voice";

import { createSelfHealingTranscriber } from "./self-healing";

export interface VoiceWireConnection {
	id: string;
}

export type VoiceRuntimeLog = (
	event: string,
	fields?: Record<string, unknown>,
) => void;

type HostWithVoiceOnMessage = { onMessage?: unknown };

export function installVoiceWireGuard(
	host: HostWithVoiceOnMessage,
	input: { log: VoiceRuntimeLog },
): void {
	const target = host as {
		onMessage?: (connection: VoiceWireConnection, message: unknown) => unknown;
	};
	const inner =
		typeof target.onMessage === "function"
			? target.onMessage.bind(host)
			: undefined;
	let binFrames = 0;
	let binBytes = 0;
	let blobChain: Promise<unknown> = Promise.resolve();
	const onBinary = (connection: VoiceWireConnection, buffer: ArrayBuffer) => {
		binFrames++;
		binBytes += buffer.byteLength;
		if (binFrames === 1 || binFrames % 100 === 0) {
			input.log("wire.binary", {
				conn: connection.id,
				frames: binFrames,
				bytes: binBytes,
			});
		}
		return inner?.(connection, buffer);
	};
	target.onMessage = (connection, message) => {
		if (message instanceof ArrayBuffer) {
			return onBinary(connection, message);
		}
		if (message instanceof Blob) {
			blobChain = blobChain.then(async () => {
				try {
					return onBinary(connection, await message.arrayBuffer());
				} catch (error) {
					input.log("wire.blob_error", {
						conn: connection.id,
						errorType:
							error instanceof TypeError
								? "TypeError"
								: error instanceof Error
									? "Error"
									: "UnknownThrown",
					});
				}
			});
			return blobChain;
		}
		if (ArrayBuffer.isView(message)) {
			return onBinary(
				connection,
				message.buffer.slice(
					message.byteOffset,
					message.byteOffset + message.byteLength,
				) as ArrayBuffer,
			);
		}
		if (typeof message === "string") {
			let parsed = false;
			try {
				JSON.parse(message);
				parsed = true;
			} catch {
				// non-JSON string frame
			}
			input.log("wire.json", { conn: connection.id, parsed });
		} else {
			input.log("wire.other", {
				conn: connection.id,
				kind: typeof message,
			});
		}
		return inner?.(connection, message);
	};
}

export function createInstrumentedVoiceTranscriber(input: {
	base: Transcriber | null | undefined;
	fields: () => Record<string, unknown>;
	log: VoiceRuntimeLog;
}): Transcriber | null {
	if (!input.base) return null;
	const healed = createSelfHealingTranscriber(input.base, {
		log: (event, fields) => input.log(event, { ...input.fields(), ...fields }),
	});
	return {
		createSession(options?: TranscriberSessionOptions): TranscriberSession {
			const startedAt = Date.now();
			let chunks = 0;
			let bytes = 0;
			let lastLoggedChunk = 0;
			input.log("stt.session.start", input.fields());
			const session = healed.createSession({
				...options,
				onInterim: (text) => {
					input.log("stt.interim", {
						...input.fields(),
						chars: text.length,
					});
					options?.onInterim?.(text);
				},
				onSpeechStart: (text) => {
					input.log("stt.speech_start", {
						...input.fields(),
						chars: text?.length ?? 0,
					});
					options?.onSpeechStart?.(text);
				},
				onUtterance: (transcript) => {
					input.log("stt.utterance.raw", {
						...input.fields(),
						chunks,
						bytes,
						chars: transcript.length,
						ms: Date.now() - startedAt,
					});
					options?.onUtterance?.(transcript);
				},
			});
			return {
				waitUntilReady: () => session.waitUntilReady?.() ?? Promise.resolve(),
				feed: (chunk: ArrayBuffer) => {
					chunks++;
					bytes += chunk.byteLength;
					if (chunks === 1 || chunks - lastLoggedChunk >= 50) {
						lastLoggedChunk = chunks;
						input.log("audio.feed", {
							...input.fields(),
							chunks,
							bytes,
							chunkBytes: chunk.byteLength,
							ms: Date.now() - startedAt,
						});
					}
					session.feed(chunk);
				},
				close: () => {
					input.log("stt.session.close", {
						...input.fields(),
						chunks,
						bytes,
						ms: Date.now() - startedAt,
					});
					session.close();
				},
			} satisfies TranscriberSession;
		},
	};
}

const FILLER_TOKENS = new Set([
	"uh",
	"um",
	"hmm",
	"hm",
	"mm",
	"mhm",
	"mmhm",
	"huh",
	"ah",
	"oh",
]);

export function isFillerOnly(trimmed: string): boolean {
	const stripped = trimmed.replace(/[.!?,…]+$/u, "").toLowerCase();
	return FILLER_TOKENS.has(stripped);
}

export function isPunctuationOnly(trimmed: string): boolean {
	return !/\p{L}|\p{N}/u.test(trimmed);
}

export function filterVoiceUtterance(
	transcript: string,
	input: {
		fields: () => Record<string, unknown>;
		log: VoiceRuntimeLog;
	},
): string | null {
	const trimmed = transcript.trim();
	if (trimmed.length === 0) {
		input.log("utterance.skipped", {
			...input.fields(),
			reason: "empty",
			chars: transcript.length,
		});
		return null;
	}
	if (isPunctuationOnly(trimmed)) {
		input.log("utterance.skipped", {
			...input.fields(),
			reason: "punctuation_only",
			chars: trimmed.length,
		});
		return null;
	}
	if (isFillerOnly(trimmed)) {
		input.log("utterance.skipped", {
			...input.fields(),
			reason: "filler_token",
			chars: trimmed.length,
		});
		return null;
	}
	input.log("utterance", {
		...input.fields(),
		chars: trimmed.length,
	});
	return transcript;
}

export class SingleSpeakerGate {
	#activeConnectionId: string | null = null;

	tryClaim(
		connection: VoiceWireConnection,
		input: {
			fields: () => Record<string, unknown>;
			log: VoiceRuntimeLog;
			missingContext?: boolean;
		},
	): boolean {
		if (input.missingContext) return false;
		if (
			this.#activeConnectionId !== null &&
			this.#activeConnectionId !== connection.id
		) {
			input.log("call.rejected", {
				...input.fields(),
				reason: "speaker_active",
				activeConn: this.#activeConnectionId,
			});
			return false;
		}
		this.#activeConnectionId = connection.id;
		return true;
	}

	release(connection: VoiceWireConnection): boolean {
		if (this.#activeConnectionId === connection.id) {
			this.#activeConnectionId = null;
			return true;
		}
		return false;
	}
}
