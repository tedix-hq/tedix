import { useCallback, useState, useSyncExternalStore } from "react";
import { useRouter, type AnyRouter } from "@tanstack/react-router";
import { ALL_CARD_SOURCES, cardSourceSearch } from "@/lib/card-source-filter";

/** App previews have no router; installed apps keep their choice in route history. */
export function useCardSourceFilter() {
	const router = useRouter<AnyRouter>({ warn: false });
	const [local, setLocal] = useState(ALL_CARD_SOURCES);
	const subscribe = useCallback(
		(notify: () => void) => router?.history.subscribe(notify) ?? (() => {}),
		[router],
	);
	const source = useSyncExternalStore(subscribe, () =>
		router
			? (cardSourceSearch(
					new URLSearchParams(router.history.location.search).get("source"),
				) ?? ALL_CARD_SOURCES)
			: local,
	);
	const setSource = (value: string) => {
		if (!router) return setLocal(value);
		void router.navigate({
			to: ".",
			search: (previous: Record<string, unknown>) => ({
				...previous,
				source:
					value === ALL_CARD_SOURCES ? undefined : cardSourceSearch(value),
			}),
			hash: router.state.location.hash,
			resetScroll: false,
		});
	};
	return [source, setSource] as const;
}
