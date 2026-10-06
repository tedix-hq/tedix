/** Bounded silence detection; only a runtime terminal frame proves completion. */

/**
 * Arm the stall watchdog for any turn that has not finalized.
 *
 * Deliberately not conditioned on the turn having text. Text is evidence the
 * runtime got far enough to speak; its absence is if anything a stronger reason
 * to keep a bound on the turn.
 */
export function shouldArmStallWatchdog(turn: { finalized: boolean }): boolean {
	return !turn.finalized;
}

/** Active work may use the runtime's 120s provider budget plus delivery time. */
export function stallWatchdogDelayMs(turn: {
	text: string;
	phase?: string;
}): number {
	return turn.phase === "finalizing" && turn.text.trim() ? 15_000 : 150_000;
}
