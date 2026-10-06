/**
 * Tedix OS theme controller.
 * Adapted and modified from Cloudflare OS under Apache-2.0; see
 * `THIRD_PARTY_NOTICES.md`.
 *
 * Three-state preference (system → light → dark) persisted to localStorage.
 * The resolved mode is applied through the shared Kumo appearance contract:
 * `data-theme="tedix"` (static token projection), `data-mode` (Kumo's own
 * styles key on it), and the supported `.dark` compatibility class (drives
 * Tailwind `dark:` variants and the `.dark` token block). `index.html` inlines
 * a pre-paint mirror of `applyResolvedMode` so first paint never flashes.
 */

import { useCallback, useSyncExternalStore } from "react";
import {
	applyOrganizationTheme,
	hydrateCachedOrganizationTheme,
} from "@/lib/organization-theme";

export type OsThemePreference = "system" | "light" | "dark";
export type OsThemeMode = "light" | "dark";

export const OS_THEME_STORAGE_KEY = "tedix-os-theme";

const CYCLE: Record<OsThemePreference, OsThemePreference> = {
	system: "light",
	light: "dark",
	dark: "system",
};

function getSystemMode(): OsThemeMode {
	if (typeof window === "undefined") return "light";
	return window.matchMedia("(prefers-color-scheme: dark)").matches
		? "dark"
		: "light";
}

export function getThemePreference(): OsThemePreference {
	if (typeof localStorage === "undefined") return "system";
	const stored = localStorage.getItem(OS_THEME_STORAGE_KEY);
	return stored === "light" || stored === "dark" ? stored : "system";
}

export function resolveThemeMode(
	preference: OsThemePreference = getThemePreference(),
): OsThemeMode {
	return preference === "system" ? getSystemMode() : preference;
}

function applyResolvedMode(mode: OsThemeMode): void {
	const root = document.documentElement;
	root.dataset.theme = "tedix";
	root.dataset.mode = mode;
	root.classList.toggle("dark", mode === "dark");
	applyOrganizationTheme(mode);
}

const listeners = new Set<() => void>();
let currentPreference: OsThemePreference =
	typeof window === "undefined" ? "system" : getThemePreference();

function notify() {
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function getSnapshot(): OsThemePreference {
	return currentPreference;
}

export function setThemePreference(preference: OsThemePreference): void {
	currentPreference = preference;
	// `getThemePreference` has always guarded the read; the write did not, and
	// it only ever ran from a click in a real browser. Hydrating the durable
	// server preference calls this on MOUNT, so any environment without
	// localStorage (SSR, a test runner, a hardened profile) now reaches it —
	// and an unguarded write there threw before the theme was ever applied.
	if (typeof localStorage !== "undefined" && localStorage !== null) {
		if (preference === "system") {
			localStorage.removeItem(OS_THEME_STORAGE_KEY);
		} else {
			localStorage.setItem(OS_THEME_STORAGE_KEY, preference);
		}
	}
	applyResolvedMode(resolveThemeMode(preference));
	notify();
}

/**
 * Bootstraps the theme on the document root and keeps the resolved mode in
 * sync with OS-level appearance changes while the preference is "system".
 * Called once from main.tsx before the first render.
 */
export function applyTedixOsTheme(): void {
	const mode = resolveThemeMode(currentPreference);
	applyResolvedMode(mode);
	hydrateCachedOrganizationTheme(mode);
	window
		.matchMedia("(prefers-color-scheme: dark)")
		.addEventListener("change", () => {
			if (currentPreference !== "system") return;
			applyResolvedMode(getSystemMode());
			notify();
		});
}

/** Theme preference hook for chrome controls (e.g. the sidebar cycle button). */
export function useOsTheme() {
	const preference = useSyncExternalStore(
		subscribe,
		getSnapshot,
		() => "system" as const,
	);

	const cycleTheme = useCallback(() => {
		setThemePreference(CYCLE[getSnapshot()]);
	}, []);

	return { cycleTheme, preference, setTheme: setThemePreference } as const;
}
