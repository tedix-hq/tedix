import type { OsOutputContent } from "@tedix/api-contract/schemas/os-workspaces";
import {
	mergeOutputContent,
	type OutputMergeOptions,
} from "@tedix/api-contract/utils/output-merge";

/**
 * What an open file editor remembers about changes someone else made while
 * the file was on screen, so each can be shown where it happened and an
 * agent's change can be taken back.
 *
 * Taking a change back never touches history: the editor saves a new change
 * that restores the earlier values, like any other edit.
 */

/** How long an agent's change set can be undone from the editor. */
export const LANDED_UNDO_MS = 30_000;
/** Change sets that follow each other this closely undo as one. */
const LANDED_BURST_MS = 8_000;
/** Someone who has not typed, clicked or scrolled for this long is watching. */
const WATCHING_AFTER_MS = 3_000;
/** How long one change stays lit, and the pause before the next one lights. */
export const LANDED_SHOWN_MS = 2_400;
const LANDED_STEP_MS = 140;
const LANDED_STEPS_MS = 1_600;

/** Whether a revision was saved by an agent and not by a person. */
export const savedByAgent = (revision: unknown) =>
	["tedi", "external_agent", "service"].includes(
		String((revision as { createdByKind?: unknown } | null)?.createdByKind),
	);

/**
 * When the change at `index` of `count` lights up, in milliseconds from now:
 * one after another, and never more than a second and a half in all.
 */
export const landedDelay = (index: number, count: number) =>
	Math.round(index * Math.min(LANDED_STEP_MS, LANDED_STEPS_MS / count));

interface Landed<Content> {
	from: Content;
	to: Content;
	agent: boolean;
	at: number;
}

export function createLandedChanges<Content extends OsOutputContent>(
	projections: Pick<
		OutputMergeOptions,
		"documentBlocks" | "presentationSlides"
	> = {},
	now: () => number = () => Date.now(),
) {
	let last: Landed<Content> | undefined;
	return {
		/**
		 * Remember that someone else's save turned the file on screen from
		 * `from` into `to`. Saves by the same kind of writer that follow each
		 * other closely count as one change set.
		 */
		add(from: Content, to: Content, agent: boolean) {
			const at = now();
			last =
				last && last.agent === agent && at - last.at < LANDED_BURST_MS
					? { ...last, to, at }
					: { from, to, agent, at };
		},
		/** Whether an agent's change set is the newest change and can be undone. */
		get undoable() {
			if (last && now() - last.at >= LANDED_UNDO_MS) last = undefined;
			return !!last?.agent;
		},
		/** The person edited the file: their edit is now the newest change. */
		clear() {
			last = undefined;
		},
		/**
		 * `content` with the newest change set taken back out. Anything edited
		 * since stays; where both touched the same part, the later edit stays.
		 */
		undo(content: Content): Content | undefined {
			const change = last;
			last = undefined;
			if (!change) return undefined;
			const result = mergeOutputContent(change.to, content, change.from, {
				...projections,
				prefer: "mine",
			});
			return result.ok ? (result.content as Content) : undefined;
		},
	};
}

/**
 * Tells whether the person is only watching the file: nothing typed, clicked
 * or scrolled for a few seconds. Only then may the editor move the view to a
 * change someone else made.
 */
export function watchForInput(
	target: Pick<Window, "addEventListener" | "removeEventListener">,
	now: () => number = () => Date.now(),
) {
	let touched = 0;
	const touch = () => {
		touched = now();
	};
	const events = ["keydown", "pointerdown", "wheel", "touchstart"] as const;
	for (const event of events)
		target.addEventListener(event, touch, { capture: true, passive: true });
	return {
		get watching() {
			return now() - touched >= WATCHING_AFTER_MS;
		},
		stop() {
			for (const event of events)
				target.removeEventListener(event, touch, { capture: true });
		},
	};
}
