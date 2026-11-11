import { useCallback, useRef, useState } from "react";
import {
	applyPatches,
	coalescePatches,
	describeConflicts,
	diffValues,
	type EditorPatch,
	type IgnorePath,
} from "@/lib/editor-patches";

/** Edits to the same field within this pause fold into one undo step. */
export const HISTORY_COALESCE_MS = 1000;

export interface EditorHistoryOptions<T> {
	limit?: number;
	/** Derived data (projections, cached values) the history must not record. */
	ignore?: IgnorePath;
	/** Rebuilds derived data after undo or redo patched the authored value. */
	project?: (value: T) => T;
	now?: () => number;
}

/**
 * Per-user undo/redo for a structured editor in a shared collab room.
 *
 * A step records only the paths this user changed (see `editor-patches`), and
 * undo patches those paths in the CURRENT shared value, so a colleague's edits
 * survive. Repeated edits to the same field within `HISTORY_COALESCE_MS` form
 * one step; `seal()` ends a step early (blur).
 */
export function useEditorHistory<T>(
	value: T,
	onChange: (next: T) => void,
	options: EditorHistoryOptions<T> = {},
) {
	const {
		limit = 100,
		ignore,
		project = (next: T) => next,
		now = Date.now,
	} = options;
	const past = useRef<EditorPatch[][]>([]);
	const future = useRef<EditorPatch[][]>([]);
	const lastCommit = useRef<number | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [, render] = useState(0);
	const refresh = () => render((version) => version + 1);

	const seal = useCallback(() => {
		lastCommit.current = null;
	}, []);

	const commit = useCallback(
		(next: T) => {
			const patches = diffValues(value, next, ignore);
			onChange(next);
			if (patches.length === 0) return;
			const at = now();
			const last = past.current.at(-1);
			const merged =
				last &&
				lastCommit.current !== null &&
				at - lastCommit.current <= HISTORY_COALESCE_MS
					? coalescePatches(last, patches, next)
					: null;
			past.current = merged
				? [...past.current.slice(0, -1), merged]
				: [...past.current.slice(-(limit - 1)), patches];
			lastCommit.current = at;
			future.current = [];
			setNotice(null);
			refresh();
		},
		[value, onChange, ignore, limit, now],
	);

	const move = useCallback(
		(direction: "undo" | "redo") => {
			const from = direction === "undo" ? past : future;
			const to = direction === "undo" ? future : past;
			const step = direction === "undo" ? from.current.at(-1) : from.current[0];
			if (!step) return;
			from.current =
				direction === "undo"
					? from.current.slice(0, -1)
					: from.current.slice(1);
			to.current =
				direction === "undo"
					? [step, ...to.current].slice(0, limit)
					: [...to.current.slice(-(limit - 1)), step];
			lastCommit.current = null;
			const result = applyPatches(value, step, direction, ignore);
			if (result.applied > 0) onChange(project(result.value));
			setNotice(
				result.conflicts.length > 0
					? describeConflicts(result.conflicts, direction)
					: null,
			);
			refresh();
		},
		[value, onChange, ignore, project, limit],
	);

	const undo = useCallback(() => move("undo"), [move]);
	const redo = useCallback(() => move("redo"), [move]);

	return {
		commit,
		undo,
		redo,
		seal,
		/** Set when the last undo or redo skipped a collaborator's newer edit. */
		notice,
		canUndo: past.current.length > 0,
		canRedo: future.current.length > 0,
	};
}
