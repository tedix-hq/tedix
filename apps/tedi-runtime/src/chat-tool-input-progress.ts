import type { ChatToolInputProgressEvent } from "@tedix/chat-transport/runtime-frames";

/**
 * Measures the AI SDK's streaming tool-input text without ever forwarding it.
 *
 * `tool-input-delta` is argument JSON. It is display-relevant only as movement:
 * something is happening during the twenty to fifty seconds before the first
 * word of an answer. So this accumulator keeps a running count per tool call
 * and emits the count, never the text.
 *
 * The count is in whole code points because a provider is free to split a
 * surrogate pair across two deltas. A high surrogate arriving alone is HELD —
 * not counted — until its low half lands in the next delta, so the number never
 * counts half of a character that nobody could see. An orphan that never gets
 * its pair is dropped rather than counted as one.
 */
export interface ToolInputProgress {
	read(
		body: string,
	): (ChatToolInputProgressEvent & Record<string, unknown>) | null;
}

interface CallState {
	chars: number;
	/** A high surrogate ended the previous delta and is waiting for its pair. */
	held: boolean;
}

function isHighSurrogate(unit: number): boolean {
	return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
	return unit >= 0xdc00 && unit <= 0xdfff;
}

/** Whole code points in `text`, continuing a surrogate held across the boundary. */
export function measureToolInputDelta(
	text: string,
	held: boolean,
): { chars: number; held: boolean } {
	let chars = 0;
	let index = 0;
	if (held && text.length > 0 && isLowSurrogate(text.charCodeAt(0))) {
		chars += 1;
		index = 1;
	}
	while (index < text.length) {
		const unit = text.charCodeAt(index);
		if (isHighSurrogate(unit)) {
			if (index + 1 >= text.length) return { chars, held: true };
			if (isLowSurrogate(text.charCodeAt(index + 1))) {
				chars += 1;
				index += 2;
				continue;
			}
		}
		chars += 1;
		index += 1;
	}
	return { chars, held: false };
}

export function createToolInputProgress(): ToolInputProgress {
	const calls = new Map<string, CallState>();
	return {
		read(body) {
			let chunk: {
				type?: unknown;
				toolCallId?: unknown;
				delta?: unknown;
				inputTextDelta?: unknown;
			};
			try {
				chunk = JSON.parse(body) as typeof chunk;
			} catch {
				return null;
			}
			const type = typeof chunk.type === "string" ? chunk.type : "";
			const toolCallId =
				typeof chunk.toolCallId === "string" ? chunk.toolCallId : "";
			if (!toolCallId) return null;
			if (type === "tool-input-start") {
				calls.set(toolCallId, { chars: 0, held: false });
				return { kind: "tool_input", toolCallId, chars: 0 };
			}
			if (type === "tool-input-delta") {
				const text =
					typeof chunk.delta === "string"
						? chunk.delta
						: typeof chunk.inputTextDelta === "string"
							? chunk.inputTextDelta
							: "";
				const state = calls.get(toolCallId) ?? { chars: 0, held: false };
				const measured = measureToolInputDelta(text, state.held);
				state.chars += measured.chars;
				state.held = measured.held;
				calls.set(toolCallId, state);
				return { kind: "tool_input", toolCallId, chars: state.chars };
			}
			// The arguments are complete or the tool has answered. Either way the
			// indicator is done and the per-call state would otherwise leak for the
			// lifetime of the Durable Object.
			if (
				type.startsWith("tool-input-available") ||
				type.startsWith("tool-output")
			)
				calls.delete(toolCallId);
			return null;
		},
	};
}
