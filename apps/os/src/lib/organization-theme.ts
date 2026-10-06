import type {
	OrganizationOsTheme,
	OsThemePalette,
} from "@tedix/api-contract/schemas/os-theme";
import type { OsThemeMode } from "@/lib/theme";

const UI_FONTS = {
	tedix:
		'"FT Kunst Grotesk", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
	system: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
	serif: 'ui-serif, Georgia, Cambria, "Times New Roman", serif',
} as const;

const CODE_FONTS = {
	"tedix-mono":
		'"Apercu Mono Pro", "SF Mono", Menlo, Monaco, Consolas, monospace',
	"system-mono": 'ui-monospace, "SF Mono", Menlo, Monaco, Consolas, monospace',
} as const;

const THEME_PROPERTIES = [
	"--background",
	"--foreground",
	"--background-lighter",
	"--background-base",
	"--card",
	"--card-foreground",
	"--popover",
	"--popover-foreground",
	"--primary",
	"--primary-foreground",
	"--secondary",
	"--secondary-foreground",
	"--muted",
	"--muted-foreground",
	"--accent",
	"--accent-foreground",
	"--border",
	"--input",
	"--ring",
	"--font-sans",
	"--font-mono",
] as const;

export const OS_ORGANIZATION_THEME_CACHE_KEY = "tedix-os-organization-theme";

/* Bumped when the compiled shape changes so a stale entry is simply ignored. */
const CACHE_VERSION = 2;

let activeTheme: OrganizationOsTheme | null = null;

function relativeLuminance(hex: string): number {
	const linear = (offset: number) => {
		const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
		return channel <= 0.04045
			? channel / 12.92
			: ((channel + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * linear(1) + 0.7152 * linear(3) + 0.0722 * linear(5);
}

/*
 * Console surface ladder, measured from the authenticated Cloudflare Console
 * and expressed as `color-mix` strengths against the tenant's own canvas so a
 * published palette keeps the ladder's shape rather than a copied swatch set.
 * Dark surfaces climb toward the foreground (OKLCH lightness 0.10 canvas →
 * 0.12 / 0.15 / 0.17 / 0.205 / 0.269 / 0.371); light shell tones recede below
 * the canvas while real surfaces lift to white. `contrast` scales the whole
 * ladder; it must never reorder it.
 */
const DARK_LADDER = {
	elevated: 2,
	recessed: 6,
	surface: 8,
	control: 12,
	tint: 19,
	border: 19,
	input: 31,
	muted: 70,
} as const;

const LIGHT_LADDER = {
	elevated: 1,
	recessed: 3,
	surface: 0,
	control: 0,
	tint: 2,
	border: 7,
	input: 15,
	muted: 55,
} as const;

/** Light mode has no room above its canvas, so surfaces lift toward white. */
const LIGHT_SURFACE_LIFT = 90;

/*
 * The high-contrast accessibility preference is an INPUT to this compiler, not
 * a stylesheet override. Everything in `THEME_PROPERTIES` is written as an
 * inline style, and an inline declaration outranks any rule, so a static
 * `:root[data-contrast="high"]` block is a silent no-op the moment an
 * organization publishes an appearance profile. Folding it in here also makes
 * the preference *narrow* the tenant palette (the documented rule) instead of
 * replacing four of its swatches with fixed greys that ignore the canvas.
 *
 * It floors the three roles that actually carry legibility — the hairline, the
 * control edge, and secondary text — and takes secondary text's companion to
 * full foreground strength. Surfaces keep the tenant's ladder shape untouched,
 * because the preference is about legibility, not surface tone.
 *
 * Floors are mix strengths toward the palette's OWN foreground, so one set is
 * correct in both polarities, and they are a floor rather than a replacement so
 * a tenant that already publishes a higher surface contrast is never narrowed
 * back down. These are the same strengths as the untenanted
 * `:root[data-contrast="high"]` block in `styles.css`; keep the two agreeing.
 */
const HIGH_CONTRAST_FLOOR = { border: 34, input: 45, muted: 78 } as const;

export interface OrganizationThemeOptions {
	/** Operator's `data-contrast="high"` preference, if already resolved. */
	highContrast?: boolean;
}

/**
 * Polarity of a published palette. `light-dark()` in the Kumo bridge resolves
 * off `color-scheme`, so the caller that writes the palette must write
 * `color-scheme` from this same test — otherwise a light-ish "dark" palette
 * gets light-ladder surfaces under the dark branch of every mix.
 */
export function paletteIsDark(palette: OsThemePalette): boolean {
	return relativeLuminance(palette.background) < 0.18;
}

export function organizationThemeVariables(
	palette: OsThemePalette,
	theme: Pick<OrganizationOsTheme, "uiFont" | "codeFont">,
	options: OrganizationThemeOptions = {},
): Record<string, string> {
	const dark = paletteIsDark(palette);
	const highContrast = options.highContrast === true;
	const ladder = dark ? DARK_LADDER : LIGHT_LADDER;
	const scale = 1 + (palette.contrast - 50) / 100;
	const step = (anchor: number, floor = 0) =>
		Math.max(
			highContrast ? floor : 0,
			Math.min(100, Math.round(anchor * scale)),
		);
	const recess = (anchor: number, floor?: number) =>
		`color-mix(in oklch, ${palette.foreground} ${step(anchor, floor)}%, ${palette.background})`;
	const lifted = `color-mix(in oklch, #ffffff ${step(LIGHT_SURFACE_LIFT)}%, ${palette.background})`;
	const surface = dark ? recess(ladder.surface) : lifted;
	const control = dark ? recess(ladder.control) : lifted;
	const tint = recess(ladder.tint);
	return {
		"--background": palette.background,
		"--foreground": palette.foreground,
		"--background-lighter": recess(ladder.elevated),
		"--background-base": recess(ladder.recessed),
		"--card": surface,
		"--card-foreground": palette.foreground,
		/* The Console keeps light overlays on the canvas and lets elevation come
		 * from the shadow; dark overlays climb to the tint step instead. */
		"--popover": dark ? tint : palette.background,
		"--popover-foreground": palette.foreground,
		"--primary": palette.accent,
		"--primary-foreground": palette.background,
		"--secondary": control,
		"--secondary-foreground": highContrast
			? palette.foreground
			: `color-mix(in oklch, ${palette.foreground} 90%, ${palette.background})`,
		"--muted": tint,
		"--muted-foreground": recess(ladder.muted, HIGH_CONTRAST_FLOOR.muted),
		"--accent": tint,
		"--accent-foreground": palette.foreground,
		"--border": recess(ladder.border, HIGH_CONTRAST_FLOOR.border),
		"--input": recess(ladder.input, HIGH_CONTRAST_FLOOR.input),
		"--ring": palette.accent,
		"--font-sans": UI_FONTS[theme.uiFont],
		"--font-mono": CODE_FONTS[theme.codeFont],
	};
}

/**
 * The contrast preference must be known before the palette is compiled, so it
 * is read from the document rather than threaded through the theme controller.
 * `applyOsPreferences` writes `data-contrast` before it touches the theme.
 */
function highContrastEnabled(): boolean {
	return (
		typeof document !== "undefined" &&
		document.documentElement.dataset.contrast === "high"
	);
}

export function applyOrganizationTheme(mode: OsThemeMode): void {
	if (typeof document === "undefined") return;
	const root = document.documentElement;
	if (!activeTheme) {
		for (const property of THEME_PROPERTIES)
			root.style.removeProperty(property);
		// Untenanted documents fall back to the stylesheet's own `color-scheme`.
		root.style.removeProperty("color-scheme");
		delete root.dataset.tenantTheme;
		return;
	}
	const palette = activeTheme[mode];
	const variables = organizationThemeVariables(palette, activeTheme, {
		highContrast: highContrastEnabled(),
	});
	for (const [property, value] of Object.entries(variables)) {
		root.style.setProperty(property, value);
	}
	// One source of truth for polarity: every `light-dark()` in the Kumo bridge
	// resolves off `color-scheme`, while the surface ladder resolves off the
	// palette's luminance. A tenant publishing a light-ish "dark" palette would
	// otherwise get light-ladder surfaces under the dark branch of every mix.
	root.style.setProperty(
		"color-scheme",
		paletteIsDark(palette) ? "dark" : "light",
	);
	root.dataset.tenantTheme = "custom";
}

export function setOrganizationTheme(theme: OrganizationOsTheme | null): void {
	activeTheme = theme;
	if (typeof localStorage !== "undefined") {
		try {
			if (theme) {
				// The cache is only a first-paint flash guard, and `data-contrast`
				// is not on the document until preferences hydrate — so compile it
				// at the standard contrast and let `applyOrganizationTheme` write
				// the high-contrast ladder once the preference is known.
				localStorage.setItem(
					OS_ORGANIZATION_THEME_CACHE_KEY,
					JSON.stringify({
						version: CACHE_VERSION,
						light: {
							variables: organizationThemeVariables(theme.light, theme),
							colorScheme: paletteIsDark(theme.light) ? "dark" : "light",
						},
						dark: {
							variables: organizationThemeVariables(theme.dark, theme),
							colorScheme: paletteIsDark(theme.dark) ? "dark" : "light",
						},
					}),
				);
			} else {
				localStorage.removeItem(OS_ORGANIZATION_THEME_CACHE_KEY);
			}
		} catch {
			// Hardened profiles may expose localStorage but reject access.
		}
	}
	const mode =
		document.documentElement.dataset.mode === "dark" ? "dark" : "light";
	applyOrganizationTheme(mode);
}

/** Restores the last server-validated compiled profile before React mounts. */
export function hydrateCachedOrganizationTheme(mode: OsThemeMode): void {
	if (typeof localStorage === "undefined" || typeof document === "undefined")
		return;
	try {
		const raw = localStorage.getItem(OS_ORGANIZATION_THEME_CACHE_KEY);
		if (!raw) return;
		type CachedMode = {
			variables?: Record<string, unknown>;
			colorScheme?: unknown;
		};
		const cache = JSON.parse(raw) as {
			version?: unknown;
			light?: CachedMode;
			dark?: CachedMode;
		};
		const cached = cache.version === CACHE_VERSION ? cache[mode] : undefined;
		const variables = cached?.variables;
		if (!variables) return;
		for (const property of THEME_PROPERTIES) {
			const value = variables[property];
			if (typeof value === "string") {
				document.documentElement.style.setProperty(property, value);
			}
		}
		if (cached.colorScheme === "dark" || cached.colorScheme === "light") {
			document.documentElement.style.setProperty(
				"color-scheme",
				cached.colorScheme,
			);
		}
		document.documentElement.dataset.tenantTheme = "custom";
	} catch {
		localStorage.removeItem(OS_ORGANIZATION_THEME_CACHE_KEY);
	}
}
