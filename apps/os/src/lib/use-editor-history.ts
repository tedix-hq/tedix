import { useCallback, useRef, useState } from "react";

/** Bounded controlled-editor undo/redo history for workbook and slide changes. */
export function useEditorHistory<T>(
	value: T,
	onChange: (next: T) => void,
	limit = 100,
) {
	const past = useRef<T[]>([]);
	const future = useRef<T[]>([]);
	const [, render] = useState(0);
	const refresh = () => render((version) => version + 1);

	const commit = useCallback(
		(next: T) => {
			past.current = [...past.current.slice(-(limit - 1)), value];
			future.current = [];
			onChange(next);
			refresh();
		},
		[value, onChange, limit],
	);

	const undo = useCallback(() => {
		const previous = past.current.at(-1);
		if (previous === undefined) return;
		past.current = past.current.slice(0, -1);
		future.current = [value, ...future.current].slice(0, limit);
		onChange(previous);
		refresh();
	}, [value, onChange, limit]);

	const redo = useCallback(() => {
		const next = future.current[0];
		if (next === undefined) return;
		future.current = future.current.slice(1);
		past.current = [...past.current.slice(-(limit - 1)), value];
		onChange(next);
		refresh();
	}, [value, onChange, limit]);

	return {
		commit,
		undo,
		redo,
		canUndo: past.current.length > 0,
		canRedo: future.current.length > 0,
	};
}
