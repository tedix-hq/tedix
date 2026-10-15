import { useSyncExternalStore } from "react";
import type { PresentationAppearance } from "@tedix/api-contract/utils/presentation-style";

const empty: PresentationAppearance = {};
let current = empty;
const listeners = new Set<() => void>();

export function setPresentationAppearance(
	organization: PresentationAppearance,
) {
	current = organization;
	for (const listener of listeners) listener();
}

export function usePresentationAppearance() {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		() => current,
		() => empty,
	);
}
