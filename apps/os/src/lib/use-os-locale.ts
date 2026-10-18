import { useSyncExternalStore } from "react";
import { readOsLocale, subscribeOsLocale } from "@/shared/os-locale";

/** Personal preferences can arrive after an app's first render. */
export function useOsLocale() {
	return useSyncExternalStore(subscribeOsLocale, readOsLocale, readOsLocale);
}
