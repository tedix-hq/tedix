import { useCallback, useSyncExternalStore } from "react";

/**
 * Subscribe to a viewport query without maintaining a second effect-driven
 * copy of browser state. The server snapshot is explicit so client-only OS
 * composition can choose its safe initial layout.
 */
export function useMediaQuery(query: string, serverSnapshot = false): boolean {
	return useSyncExternalStore(
		useCallback(
			(onChange: () => void) => {
				const list = window.matchMedia(query);
				list.addEventListener("change", onChange);
				return () => list.removeEventListener("change", onChange);
			},
			[query],
		),
		useCallback(() => window.matchMedia(query).matches, [query]),
		useCallback(() => serverSnapshot, [serverSnapshot]),
	);
}
