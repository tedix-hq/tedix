import { useEffect, useState } from "react";

/**
 * How many toolbar priority tiers are folded into "More" at the element's
 * current width: 0 shows every group, 3 folds tiers 1-3. A width the browser
 * has not measured (0) shows everything.
 */
export function toolbarCollapseLevel(
	width: number,
	thresholds: readonly [number, number, number],
): 0 | 1 | 2 | 3 {
	if (width <= 0 || width >= thresholds[0]) return 0;
	if (width >= thresholds[1]) return 1;
	if (width >= thresholds[2]) return 2;
	return 3;
}

export function useToolbarCollapse(
	element: HTMLElement | null,
	thresholds: readonly [number, number, number],
): 0 | 1 | 2 | 3 {
	const [level, setLevel] = useState<0 | 1 | 2 | 3>(0);
	const [wide, medium, narrow] = thresholds;
	useEffect(() => {
		if (!element || typeof ResizeObserver === "undefined") return;
		const measure = () =>
			setLevel(
				toolbarCollapseLevel(element.clientWidth, [wide, medium, narrow]),
			);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [element, wide, medium, narrow]);
	return level;
}
