/** Internal runtime SSE adapter. Each response owns its decoder and partial frame.
 * The browser consumes Cap'n Web callbacks, never this wire parser.
 */
export interface RuntimeFrame {
	id: string | null;
	event: Record<string, unknown>;
}

/**
 * Small cross-surface vocabulary for runtime-owned turn progress. Labels stay
 * localized by the renderer; the phase is the stable machine contract.
 */
export const CHAT_RUNTIME_PHASES = [
	"preparing_context",
	"planning",
	"generating",
	"using_tool",
	"delegating",
	"finalizing",
] as const;

export type ChatRuntimePhase = (typeof CHAT_RUNTIME_PHASES)[number];

export interface ChatRuntimePhaseEvent {
	kind: "phase";
	phase: ChatRuntimePhase;
	/** Optional runtime detail such as a tool or delegated Tedi name. */
	detail?: string;
}

export function isChatRuntimePhase(value: unknown): value is ChatRuntimePhase {
	return (
		typeof value === "string" &&
		(CHAT_RUNTIME_PHASES as readonly string[]).includes(value)
	);
}

export function readChatRuntimePhase(
	event: Record<string, unknown>,
): ChatRuntimePhaseEvent | null {
	if (event.kind !== "phase" || !isChatRuntimePhase(event.phase)) return null;
	return {
		kind: "phase",
		phase: event.phase,
		...(typeof event.detail === "string" && event.detail.trim()
			? { detail: event.detail.trim() }
			: {}),
	};
}

/**
 * Display-only tool-input progress.
 *
 * The AI SDK streams a tool's arguments as text while the model writes them,
 * and that text is the single most tempting thing to print into a transcript —
 * it is the only movement during the longest silence of a turn. It is also raw
 * arguments, which an embedded transcript must never show. So the frame
 * carries how MUCH has streamed and nothing else: a count drives a typing
 * indicator, and there is no field a renderer could print by accident.
 */
export interface ChatToolInputProgressEvent {
	kind: "tool_input";
	toolCallId: string;
	/** Whole code points of tool input streamed so far. */
	chars: number;
}

export function readChatToolInputProgress(
	event: Record<string, unknown>,
): ChatToolInputProgressEvent | null {
	if (event.kind !== "tool_input") return null;
	if (typeof event.toolCallId !== "string" || !event.toolCallId) return null;
	const chars = typeof event.chars === "number" ? event.chars : 0;
	return {
		kind: "tool_input",
		toolCallId: event.toolCallId,
		chars: Number.isFinite(chars) ? Math.max(0, Math.trunc(chars)) : 0,
	};
}

export async function consumeRuntimeFrames(
	response: Response,
	deliver: (frame: RuntimeFrame) => Promise<void>,
): Promise<void> {
	if (!response.ok || !response.body)
		throw new Error("Runtime stream unavailable");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { value, done } = await reader.read();
			buffer += decoder.decode(value, { stream: !done });
			if (buffer.length > 1_048_576)
				throw new Error("Runtime frame exceeds limit");
			let boundary: RegExpExecArray | null;
			while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
				const raw = buffer.slice(0, boundary.index);
				buffer = buffer.slice(boundary.index + boundary[0].length);
				let id: string | null = null;
				const data: string[] = [];
				for (const line of raw.split(/\r?\n/)) {
					if (line.startsWith("id:")) id = line.slice(3).trim();
					if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
				}
				if (!data.length) continue;
				const event: unknown = JSON.parse(data.join("\n"));
				if (!event || typeof event !== "object" || Array.isArray(event)) {
					throw new Error("Invalid runtime frame");
				}
				await deliver({ id, event: event as Record<string, unknown> });
			}
			if (done) break;
		}
		// Incomplete trailing bytes are deliberately discarded. Only delivered
		// frame IDs can become replay cursors; a new response starts with no bytes.
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
