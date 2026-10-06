import type { ChatRuntimePhaseEvent } from "@tedix/chat-transport/runtime-frames";

type PhaseFrame = ChatRuntimePhaseEvent & Record<string, unknown>;

/** Translate the one authoritative AI SDK tool-start chunk into chat progress. */
export function runtimeToolPhase(body: string): PhaseFrame | null {
	try {
		const chunk = JSON.parse(body) as { type?: unknown; toolName?: unknown };
		if (chunk.type !== "tool-input-start") return null;
		return {
			kind: "phase",
			phase: "using_tool",
			...(typeof chunk.toolName === "string" ? { detail: chunk.toolName } : {}),
		};
	} catch {
		return null;
	}
}

/**
 * Per-turn phase derivation from the raw AI SDK chunk stream. The model loop
 * starts in `planning`; `generating` is stamped only when assistant text
 * actually begins (`text-start`, or the first `text-delta` when a provider
 * skips the start frame) and `using_tool` on each tool-input-start. A phase
 * is emitted once per transition, never per token, so a narrate-then-act
 * turn yields planning → generating → using_tool → generating.
 */
export function createRuntimePhaseTracker(): {
	start: () => PhaseFrame;
	read: (body: string) => PhaseFrame | null;
} {
	let current: ChatRuntimePhaseEvent["phase"] = "planning";
	return {
		start: () => ({ kind: "phase", phase: current }),
		read: (body) => {
			const tool = runtimeToolPhase(body);
			if (tool) {
				current = "using_tool";
				return tool;
			}
			try {
				const chunk = JSON.parse(body) as { type?: unknown };
				if (chunk.type !== "text-start" && chunk.type !== "text-delta")
					return null;
			} catch {
				return null;
			}
			if (current === "generating") return null;
			current = "generating";
			return { kind: "phase", phase: current };
		},
	};
}
