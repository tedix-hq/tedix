/**
 * Machine load pressure, so a contended gate can be told apart from a broken one.
 *
 * A gate on an oversubscribed machine fails the same way as a broken one, so
 * report load alongside a failure instead of letting it read as a regression.
 *
 * So this module only measures and describes. It never blocks: backpressure can
 * answer WHETHER to proceed but never WHO proceeds, and N waiters on one
 * threshold release in lockstep. Serialising gate runs needs a real token, not a
 * number every agent reads independently.
 */

import { cpus, loadavg } from "node:os";

/** Load per core beyond which the machine is meaningfully oversubscribed. */
export const OVERSUBSCRIBED_RATIO = 2;

export type LoadPressure = {
	/** 1-minute load average. */
	load1: number;
	/** Logical cores, floored at 1 so the ratio is always defined. */
	cores: number;
	/** `load1 / cores` — the portable way to compare across machines. */
	ratio: number;
	oversubscribed: boolean;
};

export function readLoadPressure(
	read: () => { load1: number; cores: number } = () => ({
		load1: loadavg()[0] ?? 0,
		cores: cpus().length,
	}),
): LoadPressure {
	const raw = read();
	// Containers and some CI runners report zero cores; a divide-by-zero here
	// would report every machine as infinitely oversubscribed.
	const cores = Math.max(1, raw.cores);
	const load1 = Math.max(0, raw.load1);
	const ratio = load1 / cores;
	return {
		load1,
		cores,
		ratio,
		oversubscribed: ratio >= OVERSUBSCRIBED_RATIO,
	};
}

/**
 * A one-line description of the pressure, or null when the machine is healthy
 * and the reader should not be given something irrelevant to weigh.
 */
export function describeLoadPressure(pressure: LoadPressure): string | null {
	if (!pressure.oversubscribed) return null;
	return `machine load ${pressure.load1.toFixed(1)} across ${pressure.cores} core(s) — ${pressure.ratio.toFixed(1)}x oversubscribed`;
}

/**
 * What to tell someone whose gates just failed on an oversubscribed machine.
 * Deliberately phrased as a possibility: contention makes gates slow and can get
 * them killed outright, but it does not make a genuine type error disappear.
 */
export function contentionAdvice(pressure: LoadPressure): string | null {
	const description = describeLoadPressure(pressure);
	if (!description) return null;
	return (
		`\nNOTE: ${description}.\n` +
		"Under this much contention gates run several times slower and can be\n" +
		"killed outright, so a failure here may be the machine rather than your\n" +
		"change. Check whether other agents or worktrees are running full-repo\n" +
		"typechecks before treating this as a code problem — and do not 'fix' a\n" +
		"gate that was never broken."
	);
}
