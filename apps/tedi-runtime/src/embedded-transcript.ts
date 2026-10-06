import type { EmbeddedTranscript } from "@tedix/chat-transport/embedded-contract";

const USER_TEXT_PREFIX = "Tedix embedded user message v1: ";
export const EMBEDDED_TRANSCRIPT_LIMIT = 100;

/** JSON keeps arbitrary newlines and delimiter-like user text on one line.
 * This is presentation metadata, never an authority or an instruction fence.
 * The normal runtime untrusted-input boundary still owns model safety.
 */
export function embeddedUserText(text: string): string {
	return `${USER_TEXT_PREFIX}${JSON.stringify(text)}`;
}

/** Never infer an old message's user/context boundary from natural-language
 * delimiters. Legacy user messages without the versioned envelope are omitted.
 */
export function originalUserText(content: string): string | null {
	const firstLine = content.split("\n", 1)[0] ?? "";
	if (!firstLine.startsWith(USER_TEXT_PREFIX)) return null;
	try {
		const encoded = firstLine.slice(USER_TEXT_PREFIX.length);
		const text: unknown = JSON.parse(encoded);
		return typeof text === "string" && JSON.stringify(text) === encoded
			? text
			: null;
	} catch {
		return null;
	}
}

export function projectEmbeddedTranscript(
	payload: unknown,
): EmbeddedTranscript {
	if (
		!payload ||
		typeof payload !== "object" ||
		!("messages" in payload) ||
		!Array.isArray(payload.messages)
	) {
		throw new Error("Embedded conversation history unavailable");
	}
	const messages: EmbeddedTranscript["messages"] = [];
	for (const message of payload.messages.slice(-EMBEDDED_TRANSCRIPT_LIMIT)) {
		if (
			!message ||
			typeof message !== "object" ||
			typeof message.content !== "string"
		)
			continue;
		if (message.role === "assistant") {
			messages.push({ role: "assistant", content: message.content });
		} else if (message.role === "user") {
			const content = originalUserText(message.content);
			if (content !== null) messages.push({ role: "user", content });
		}
	}
	return { messages };
}
