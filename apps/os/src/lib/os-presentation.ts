/**
 * Applies the durable preference set to the document, and to the shared
 * formatting helpers.
 *
 * Theme keeps its own module (`./theme`) because a pre-paint mirror of it is
 * inlined in `index.html`; everything here is post-hydration and safe to apply
 * once preferences arrive from the server.
 *
 * The rule this module exists to hold: a preference that reaches the document
 * must CHANGE something. `data-density`, `data-motion` and `data-contrast` all
 * have matching rules in `styles.css`, and locale/timezone are read by
 * `./time` and `./format`. Nothing here writes an attribute no stylesheet
 * consumes.
 *
 * `data-contrast` has a second consumer: under a published organization
 * appearance profile the static rule is inert (inline styles win), so
 * `organization-theme.ts` reads the attribute and compiles the high-contrast
 * ladder itself. That is why it is written before the theme below.
 */

import type { OsUserPreferences } from "@tedix/api-contract/schemas/user-settings";
import { setOsFormattingPreferences } from "@/lib/format";
import { setThemePreference } from "@/lib/theme";

export function applyOsPreferences(preferences: OsUserPreferences): void {
	// Attributes first, theme second — and the order is load-bearing, not
	// stylistic. `data-contrast` is an INPUT to the organization theme compiler
	// (a published palette writes `--border`/`--input`/`--muted-foreground`/
	// `--secondary-foreground` as inline styles, which no stylesheet rule can
	// override), and `setThemePreference` is what compiles and writes it.
	const root = document.documentElement;
	root.dataset.density = preferences.density;
	// "system" removes the attribute entirely so the `prefers-*` media queries
	// the stylesheet already honors stay in charge — writing `data-motion="system"`
	// would need a third rule that means "do nothing".
	if (preferences.accessibility.motion === "system") {
		delete root.dataset.motion;
	} else {
		root.dataset.motion = preferences.accessibility.motion;
	}
	if (preferences.accessibility.contrast === "system") {
		delete root.dataset.contrast;
	} else {
		root.dataset.contrast = preferences.accessibility.contrast;
	}

	setThemePreference(preferences.theme);

	setOsFormattingPreferences({
		locale: preferences.locale,
		timezone: preferences.timezone,
	});
}
