/**
 * The one Descope theming bridge for every OS zone.
 *
 * Account (BYOS login flow) and product (step-up dialog, end-user widgets)
 * surfaces historically applied two divergent subsets of this — the login
 * flow had the brand override and surface tokens but no styleId/logger, and
 * the product surfaces had styleId/logger but no override. Both zones now
 * source all four pieces from here; only the theme-MODE hook stays
 * zone-local (`@/lib/theme` for account, `@/hooks/use-descope-theme` for
 * product) because the shared zone may import neither.
 *
 * `__DESCOPE_STYLE_ID__` is a compile-time define (vite.config.ts), declared
 * in src/env.d.ts.
 */

import type { ILogger } from "@descope/react-sdk/flows";

export const DESCOPE_STYLE_ID = __DESCOPE_STYLE_ID__ || undefined;

const descopeLogger: ILogger = Object.freeze({
	info: () => {},
	warn: () => {},
	error: (title, description, state) => {
		console.error("[Descope]", title, description, state);
	},
});

const DESCOPE_STYLE_PROPS: Readonly<{
	styleId?: string;
	logger: ILogger;
	debug: false;
}> = Object.freeze({
	...(DESCOPE_STYLE_ID ? { styleId: DESCOPE_STYLE_ID } : {}),
	logger: descopeLogger,
	debug: false,
});

export function descopeStyleProps(): {
	styleId?: string;
	logger: ILogger;
	debug: false;
} {
	return DESCOPE_STYLE_PROPS;
}

// Descope renders in Shadow DOM, so its brand colors cannot consume the OS
// CSS variables directly. Keep this narrow runtime override in sync with the
// two primary token sets in styles.css; the rest of the surface stays
// Descope-owned.
const TEDIX_DESCOPE_THEME_OVERRIDE = {
	light: {
		globals: {
			colors: {
				primary: {
					main: "#5b47e0",
					dark: "#4534b8",
					light: "#8b7bf7",
					highlight: "#edeafd",
					contrast: "#ffffff",
				},
				secondary: {
					main: "#6d5ce8",
					dark: "#4534b8",
					light: "#a68bff",
					highlight: "#edeafd",
					contrast: "#ffffff",
				},
			},
		},
	},
	dark: {
		globals: {
			colors: {
				primary: {
					main: "#8b7bf7",
					dark: "#6d5ce8",
					light: "#a68bff",
					highlight: "#29243d",
					contrast: "#17151f",
				},
				secondary: {
					main: "#a68bff",
					dark: "#8b7bf7",
					light: "#c0b5ff",
					highlight: "#29243d",
					contrast: "#17151f",
				},
			},
		},
	},
};

/**
 * react-sdk 3.x forwards `themeOverride` to the web component's
 * theme-override attribute. That component parses JSON, while passing the
 * documented object directly produces only "[object Object]" in this SDK
 * pair. Serialize at the third-party boundary; call sites cast to the SDK's
 * prop type until the upstream types agree.
 */
export const TEDIX_DESCOPE_THEME_OVERRIDE_JSON = JSON.stringify(
	TEDIX_DESCOPE_THEME_OVERRIDE,
);

const TEDIX_DESCOPE_SURFACE_STYLE_ID = "tedix-descope-surface-tokens";
const TEDIX_DESCOPE_SURFACE_STYLES = `
#root[data-theme="light"],
#root[data-theme="dark"] {
	--descope-colors-surface-main: var(--background-lighter) !important;
	--descope-colors-surface-dark: var(--muted-foreground) !important;
	--descope-colors-surface-light: var(--secondary) !important;
	--descope-colors-surface-highlight: var(--accent) !important;
	--descope-colors-surface-contrast: var(--foreground) !important;
}
`;

/** Bridge OS surface tokens that Descope's official runtime override omits. */
export function installTedixDescopeSurfaceTokens(
	element: HTMLElement | null,
): void {
	const shadowRoot = element?.shadowRoot;
	if (
		!shadowRoot ||
		shadowRoot.getElementById(TEDIX_DESCOPE_SURFACE_STYLE_ID)
	) {
		return;
	}
	const style = element.ownerDocument.createElement("style");
	style.id = TEDIX_DESCOPE_SURFACE_STYLE_ID;
	style.textContent = TEDIX_DESCOPE_SURFACE_STYLES;
	shadowRoot.append(style);
}
