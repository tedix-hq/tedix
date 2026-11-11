import { useCallback, useEffect, useRef } from "react";

/**
 * Autosave for shared output drafts.
 *
 * The collaboration room shares every keystroke with peers, but it never writes
 * a saved version: only a commit does. Without autosave, a draft can look
 * finished in the editor while every reader of the output (other people's
 * reloads, agents, workflows) still sees the last saved version. Autosave
 * closes that gap by committing the editing client's own changes shortly after
 * it stops typing.
 *
 * Only the client that typed saves. Peers that merely receive remote edits do
 * not race each other for the same commit; each person's client saves what
 * that person wrote.
 */

/** Quiet time after the last local edit before a version is saved. */
export const AUTOSAVE_IDLE_MS = 3_000;
/** Shortest gap between two autosaved versions, so typing in bursts does not
 * turn every pause into a new revision. */
export const AUTOSAVE_MIN_INTERVAL_MS = 15_000;
/** Revision note that marks a version as saved automatically. */
export const AUTOSAVE_NOTE = "Autosaved";

/** Milliseconds to wait before the next autosave may run. */
export function autosaveDelay(input: {
	now: number;
	lastLocalEditAt: number;
	lastAutosaveAt: number | null;
}): number {
	const idle = input.lastLocalEditAt + AUTOSAVE_IDLE_MS - input.now;
	const gap =
		input.lastAutosaveAt === null
			? 0
			: input.lastAutosaveAt + AUTOSAVE_MIN_INTERVAL_MS - input.now;
	return Math.max(0, idle, gap);
}

/**
 * Schedules autosaves for local edits.
 *
 * - `editStamp` increases on every local edit (0 means none yet).
 * - `ready` is true only when a commit is currently allowed and would change
 *   something; the caller owns those rules.
 * - `save` performs the commit and resolves `true` when it sent a request,
 *   `false` when it declined (for example, edits were still in flight). A
 *   declined save keeps the edits pending so the next ready moment retries.
 *
 * A save that was sent and failed is not retried until the next local edit, so
 * a persistent error cannot loop.
 *
 * When the page is hidden or closed, pending edits are saved immediately, best
 * effort.
 */
export function useDraftAutosave(options: {
	ready: boolean;
	editStamp: number;
	save: () => Promise<boolean>;
}): { pending: boolean } {
	const { ready, editStamp, save } = options;
	const lastLocalEditAt = useRef(0);
	const lastAutosaveAt = useRef<number | null>(null);
	const attemptedStamp = useRef(0);
	const running = useRef(false);
	const latest = useRef({ ready, editStamp, save });
	latest.current = { ready, editStamp, save };

	useEffect(() => {
		if (editStamp > 0) lastLocalEditAt.current = Date.now();
	}, [editStamp]);

	const run = useCallback(async () => {
		const current = latest.current;
		if (
			running.current ||
			!current.ready ||
			current.editStamp <= attemptedStamp.current
		) {
			return;
		}
		running.current = true;
		const previous = attemptedStamp.current;
		const previousAt = lastAutosaveAt.current;
		attemptedStamp.current = current.editStamp;
		lastAutosaveAt.current = Date.now();
		try {
			const sent = await current.save();
			if (!sent) {
				attemptedStamp.current = previous;
				lastAutosaveAt.current = previousAt;
			}
		} catch {
			// The save path reports its own errors on screen.
		} finally {
			running.current = false;
		}
	}, []);

	const pending = editStamp > attemptedStamp.current;

	useEffect(() => {
		if (!ready || !pending) return;
		const timer = setTimeout(
			() => void run(),
			autosaveDelay({
				now: Date.now(),
				lastLocalEditAt: lastLocalEditAt.current,
				lastAutosaveAt: lastAutosaveAt.current,
			}),
		);
		return () => clearTimeout(timer);
	}, [ready, pending, editStamp, run]);

	useEffect(() => {
		const flush = () => {
			if (document.visibilityState === "hidden") void run();
		};
		const flushOnLeave = () => void run();
		document.addEventListener("visibilitychange", flush);
		window.addEventListener("pagehide", flushOnLeave);
		return () => {
			document.removeEventListener("visibilitychange", flush);
			window.removeEventListener("pagehide", flushOnLeave);
		};
	}, [run]);

	return { pending };
}
