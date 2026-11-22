import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";

/** Keep the socket until pending mutations have received their acknowledgements. */
export function usePollingVisible(): boolean {
	const client = useQueryClient();
	const subscribe = useCallback(
		(notify: () => void) => {
			document.addEventListener("visibilitychange", notify);
			const unsubscribe = client.getMutationCache().subscribe(notify);
			return () => {
				document.removeEventListener("visibilitychange", notify);
				unsubscribe();
			};
		},
		[client],
	);
	return useSyncExternalStore(
		subscribe,
		() => !document.hidden || client.isMutating() > 0,
		() => false,
	);
}
