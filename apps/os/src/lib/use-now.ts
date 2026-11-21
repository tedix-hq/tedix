import { useEffect, useState } from "react";

/** Re-render every `everyMs` (a second by default) while `active`, so elapsed time keeps counting. */
export function useNow(active: boolean, everyMs = 1_000): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), everyMs);
		return () => clearInterval(timer);
	}, [active, everyMs]);
	return active ? now : Date.now();
}
