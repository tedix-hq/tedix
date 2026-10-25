import { useEffect, useState } from "react";

/** Re-render once a second while `active`, so elapsed time keeps counting. */
export function useNow(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		const timer = setInterval(() => setNow(Date.now()), 1_000);
		return () => clearInterval(timer);
	}, [active]);
	return active ? now : Date.now();
}
