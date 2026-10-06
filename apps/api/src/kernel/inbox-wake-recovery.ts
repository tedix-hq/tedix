/**
 * Cold-start recovery for persisted Kernel inbox wakes.
 *
 * Child completion writes D1 `kernel_wake_queue` before calling the Kernel DO.
 * The push is only a hint: if the RPC or alarm write is interrupted, the next
 * activation must re-arm delivery from the canonical queue instead of waiting
 * for the periodic reconciliation sweep.
 */

export interface PendingInboxWakeRecoveryDeps {
	hasPendingWake(): Promise<boolean>;
	ensureAlarm(targetMs: number): Promise<void>;
	now?: () => number;
	delayMs: number;
}

/**
 * Default debounce between a terminal child notification and the durable wake
 * drain. A short debounce still coalesces near-simultaneous plan branches while
 * keeping the queue hop below the operator-visible one-second boundary.
 */
export const DEFAULT_INBOX_WAKE_DELAY_MS = 250;

const MIN_INBOX_WAKE_DELAY_MS = 100;
const MAX_INBOX_WAKE_DELAY_MS = 5_000;

/** Resolve the bounded production tuning knob without trusting malformed vars. */
export function resolveInboxWakeDelayMs(raw: string | undefined): number {
	if (!raw) return DEFAULT_INBOX_WAKE_DELAY_MS;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed)) return DEFAULT_INBOX_WAKE_DELAY_MS;
	return Math.min(
		MAX_INBOX_WAKE_DELAY_MS,
		Math.max(MIN_INBOX_WAKE_DELAY_MS, parsed),
	);
}

/**
 * Re-arm the inbox alarm when canonical storage proves work is pending.
 * Returns true only when an alarm was requested. Errors deliberately propagate
 * so the DO boundary can log them with its normal operational context.
 */
export async function recoverPendingInboxWake(
	deps: PendingInboxWakeRecoveryDeps,
): Promise<boolean> {
	if (!(await deps.hasPendingWake())) return false;
	await deps.ensureAlarm((deps.now?.() ?? Date.now()) + deps.delayMs);
	return true;
}
