/**
 * Pure decision logic and terminal-reset helpers for P4 interrupt/steer.
 * Keyboard wiring lives in index.ts (not unit-testable without a real TTY).
 */

export type InterruptAction = "prompt" | "abort" | "clear" | "exit";

export interface InterruptState {
	isTty: boolean;
	turnRunning: boolean;
	secondPressWithinWindow: boolean;
	hasText: boolean;
}

/**
 * Classify a Ctrl-C event into the appropriate action.
 *
 * - non-TTY → always 'exit' (match today's behavior for piped/JSON/--no-poll)
 * - turn running, first press → 'prompt' ([c]ancel/[s]teer/[w]ait)
 * - turn running, second press within 1500ms → 'abort' (hard AbortController)
 * - turn idle, line has text → 'clear' (wipe the input line)
 * - turn idle, empty line → 'exit'
 */
export function classifyInterrupt(state: InterruptState): InterruptAction {
	if (!state.isTty) return "exit";
	if (state.turnRunning) {
		return state.secondPressWithinWindow ? "abort" : "prompt";
	}
	return state.hasText ? "clear" : "exit";
}

/**
 * Write escape sequences to disable DEC mouse tracking, SGR mouse mode, and
 * bracketed paste — undoing input modes a crashed prior session may have left
 * on. Call on startup AND process exit so a crash never leaves the parent shell
 * in a broken state.
 *
 * Deliberately does NOT touch the alternate screen: the CLI never ENTERS it
 * (no `?1049h` anywhere), and emitting a bare `?1049l` makes terminals
 * (Terminal.app / iTerm / Termius) restore the main buffer to a home cursor —
 * which clears the screen and jumps to the top on every startup.
 *
 * @param write - injected writer (e.g. process.stdout.write.bind(process.stdout))
 */
export function resetTerminalModes(write: (s: string) => void): void {
	write("\x1B[?1000l"); // disable mouse tracking
	write("\x1B[?1006l"); // disable SGR mouse mode
	write("\x1B[?2004l"); // disable bracketed paste
}
