export interface PlatformBrandingResolution {
	platformBranding: Record<string, unknown>;
	platformImages: Record<string, unknown>;
	googleFontsHref: string | null;
	themeMode: "light" | "dark" | "system";
	allowThemeSwitch: boolean;
	htmlClass: "light" | "dark" | undefined;
	brandCss: string;
}

const GOOGLE_FONT_PARAMS: Record<string, string> = {
	Comfortaa: "Comfortaa:wght@400;500;600;700",
	"Exo 2": "Exo+2:ital,wght@0,400;0,500;0,600;0,700;1,400",
	Raleway: "Raleway:ital,wght@0,400;0,500;0,600;0,700;0,800;1,400;1,600",
	Roboto: "Roboto:ital,wght@0,400;0,500;0,700;1,400",
	"Source Sans Pro": "Source+Sans+Pro:ital,wght@0,400;0,600;0,700;1,400",
};

const stringValue = (value: unknown): string | null =>
	typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const recordValue = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" ? (value as Record<string, unknown>) : {};

const cleanFontFamily = (value: unknown): string | null => {
	const raw = stringValue(value);
	if (!raw || !/^[A-Za-z0-9 -]+$/.test(raw)) return null;
	return raw.replace(/\s+/g, " ");
};

const cssFontFamily = (
	value: string | null,
	fallback: string,
): string | null =>
	value ? `"${value.replaceAll('"', '\\"')}", ${fallback}` : null;

const cssValue = (value: unknown): string | null => {
	const raw = stringValue(value);
	return raw ? raw.replace(/[;{}]/g, "").trim() : null;
};

const hexLightness = (value: string | null): number | null => {
	if (!value) return null;
	const match = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
	if (!match) return null;
	const raw = match[1]!;
	const hex =
		raw.length === 3
			? raw
					.split("")
					.map((part) => `${part}${part}`)
					.join("")
			: raw;
	const [r, g, b] = [0, 2, 4].map(
		(start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255,
	) as [number, number, number];
	const linear = [r, g, b].map((channel) =>
		channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
	);
	return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
};

export function safeBrandingHttpUrl(value: unknown): string | null {
	const raw = stringValue(value);
	if (!raw) return null;
	try {
		const url = new URL(raw);
		return url.protocol === "https:" || url.protocol === "http:"
			? url.toString()
			: null;
	} catch {
		return null;
	}
}

export function resolvePlatformBranding(
	env: Record<string, string | undefined>,
): PlatformBrandingResolution {
	let platformBranding: Record<string, unknown> = {};
	try {
		platformBranding = env.PLATFORM_BRANDING
			? recordValue(JSON.parse(env.PLATFORM_BRANDING))
			: {};
	} catch {
		platformBranding = {};
	}

	const platformImages = recordValue(platformBranding.images);
	const platformColors = recordValue(platformBranding.colors);
	const platformFonts = recordValue(platformBranding.fonts);
	const fontBody = cleanFontFamily(platformFonts.body);
	const fontHeading = cleanFontFamily(platformFonts.heading);
	const fontProvider = stringValue(platformFonts.provider) ?? "google";
	const requestedGoogleFonts =
		fontProvider === "google"
			? Array.from(
					new Set(
						[fontBody, fontHeading].filter((font): font is string =>
							Boolean(font && GOOGLE_FONT_PARAMS[font]),
						),
					),
				)
			: [];
	const googleFontsHref =
		requestedGoogleFonts.length > 0
			? `https://fonts.googleapis.com/css2?${requestedGoogleFonts
					.map((font) => `family=${GOOGLE_FONT_PARAMS[font]}`)
					.join("&")}&display=swap`
			: null;

	const rawThemeMode =
		stringValue(platformBranding.themeMode) ??
		stringValue(platformBranding.colorScheme);
	const themeMode =
		rawThemeMode === "light" ||
		rawThemeMode === "dark" ||
		rawThemeMode === "system"
			? rawThemeMode
			: "system";
	const allowThemeSwitch = themeMode === "system";

	const primaryColor = cssValue(platformColors.primary);
	const accentColor = cssValue(platformColors.accent ?? platformColors.primary);
	const secondaryColor = cssValue(platformColors.secondary);
	const explicitBrandHover = cssValue(
		platformColors.primaryHover ??
			platformColors.primaryDark ??
			platformColors.interactiveHover,
	);
	const explicitBrandTint = cssValue(
		platformColors.tint ??
			platformColors.primaryTint ??
			platformColors.brandTint ??
			platformColors.backgroundTint,
	);
	const secondaryIsTint = (hexLightness(secondaryColor) ?? 0) > 0.82;
	const brandHoverColor =
		explicitBrandHover ??
		(!secondaryIsTint ? secondaryColor : null) ??
		(primaryColor ? `color-mix(in srgb, ${primaryColor} 82%, black)` : null);
	const brandTintColor =
		explicitBrandTint ??
		(secondaryIsTint ? secondaryColor : null) ??
		(primaryColor ? `color-mix(in srgb, ${primaryColor} 8%, white)` : null);
	const brandCssVars: Array<[string, string | null]> = [
		["--color-brand-50", brandTintColor],
		["--color-brand-500", accentColor],
		["--color-brand-600", primaryColor],
		["--color-brand-700", brandHoverColor],
		["--color-bg", cssValue(platformColors.background)],
		["--color-text", cssValue(platformColors.text)],
		["--color-text-secondary", cssValue(platformColors.textSecondary)],
		["--color-muted", cssValue(platformColors.textSecondary)],
		[
			"--font-display",
			cssFontFamily(fontHeading, "ui-rounded, system-ui, sans-serif"),
		],
		[
			"--font-sans",
			cssFontFamily(fontBody, "ui-sans-serif, system-ui, sans-serif"),
		],
	];

	return {
		platformBranding,
		platformImages,
		googleFontsHref,
		themeMode,
		allowThemeSwitch,
		htmlClass: allowThemeSwitch ? undefined : themeMode,
		brandCss: brandCssVars
			.filter((entry): entry is [string, string] => Boolean(entry[1]))
			.map(([name, value]) => `${name}: ${value};`)
			.join(""),
	};
}
