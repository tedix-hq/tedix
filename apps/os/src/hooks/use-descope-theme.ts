/**
 * Returns the current theme as "light" | "dark" for Descope component props.
 * Delegates to the app-wide useTheme hook.
 */

import { useTheme } from "./use-theme";

export function useDescopeTheme(): "light" | "dark" {
	const { theme } = useTheme();
	return theme;
}
