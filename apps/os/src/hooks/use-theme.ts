/**
 * Adapter-compatible theme hook shape over the OS theme system.
 *
 * A Kumo adapter that imports `@/hooks/use-theme` can use this stable shape.
 * The OS theme system stays the single owner and this file only adapts its
 * shape.
 */

import { useOsTheme, resolveThemeMode, setThemePreference } from "@/lib/theme";

export function useTheme() {
	const { preference } = useOsTheme();
	return {
		theme: resolveThemeMode(preference),
		setTheme: (theme: "light" | "dark") => setThemePreference(theme),
	};
}
