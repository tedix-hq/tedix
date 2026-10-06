/**
 * Turn-liveness classification for the tedix CLI bridge and REPL.
 * A stream heartbeat or successful poll updates lastActivityAt; the gap
 * drives the live/slow/stuck verdict. Zero means no active heartbeat and
 * is classified as live.
 */

export type TurnLivenessLevel = "live" | "slow" | "stuck";

/** No heartbeat for this long → "slow" ("Still working…"). */
export const TURN_LIVENESS_SLOW_MS = 30_000;
/** No heartbeat for this long → "stuck" ("This turn looks stuck"). */
export const TURN_LIVENESS_STUCK_MS = 90_000;

/**
 * Classify turn liveness from the last stream heartbeat. Pure. A
 * `lastActivityAt` of 0 (no turn in flight) is always "live".
 */
export function classifyTurnLiveness(
	lastActivityAt: number,
	now: number,
): TurnLivenessLevel {
	if (lastActivityAt === 0) return "live";
	const gap = now - lastActivityAt;
	if (gap >= TURN_LIVENESS_STUCK_MS) return "stuck";
	if (gap >= TURN_LIVENESS_SLOW_MS) return "slow";
	return "live";
}

/**
 * Coarse human duration for the liveness label ("8s" / "2m 5s" / "1h 3m").
 * Deliberately coarser than the CLI's precise `formatDuration` (which is right
 * for the panel cost column); the CLI REPL uses this for the "Still working…
 * (Nm)" copy so the wording reads the same everywhere.
 */
export function formatTurnDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "0s";
	const totalSeconds = Math.floor(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) {
		return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
	}
	const hours = Math.floor(minutes / 60);
	const remMinutes = minutes % 60;
	return remMinutes === 0 ? `${hours}h` : `${hours}h ${remMinutes}m`;
}
