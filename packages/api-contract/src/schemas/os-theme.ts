import * as z from "zod";

const HexColorSchema = z
	.string()
	.regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex color")
	.transform((value) => value.toLowerCase());

function relativeLuminance(hex: string): number {
	const linearChannel = (offset: number) => {
		const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
		return channel <= 0.04045
			? channel / 12.92
			: ((channel + 0.055) / 1.055) ** 2.4;
	};
	const red = linearChannel(1);
	const green = linearChannel(3);
	const blue = linearChannel(5);
	return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(a: string, b: string): number {
	const lighter = Math.max(relativeLuminance(a), relativeLuminance(b));
	const darker = Math.min(relativeLuminance(a), relativeLuminance(b));
	return (lighter + 0.05) / (darker + 0.05);
}

export const OsUiFontSchema = z.enum(["tedix", "system", "serif"]);
export type OsUiFont = z.infer<typeof OsUiFontSchema>;

export const OsCodeFontSchema = z.enum(["tedix-mono", "system-mono"]);
export type OsCodeFont = z.infer<typeof OsCodeFontSchema>;

export const OsThemePaletteSchema = z
	.object({
		accent: HexColorSchema,
		background: HexColorSchema,
		foreground: HexColorSchema,
		/** Scales the derived surface ladder; 50 is the Console's own spacing. */
		contrast: z.number().int().min(0).max(100),
	})
	.strict()
	.superRefine((palette, ctx) => {
		if (contrastRatio(palette.foreground, palette.background) < 4.5) {
			ctx.addIssue({
				code: "custom",
				path: ["foreground"],
				message: "Foreground and background must have at least 4.5:1 contrast",
			});
		}
		if (contrastRatio(palette.accent, palette.background) < 4.5) {
			ctx.addIssue({
				code: "custom",
				path: ["accent"],
				message: "Accent and background must have at least 4.5:1 contrast",
			});
		}
	});
export type OsThemePalette = z.infer<typeof OsThemePaletteSchema>;

/**
 * Organization-owned OS appearance inputs. Secondary surface, border, muted,
 * hover, focus, and Kumo component tokens are derived by the OS theme compiler;
 * tenants never write arbitrary CSS or internal design-system variables.
 */
export const OrganizationOsThemeSchema = z
	.object({
		version: z.literal(1),
		light: OsThemePaletteSchema,
		dark: OsThemePaletteSchema,
		uiFont: OsUiFontSchema,
		codeFont: OsCodeFontSchema,
	})
	.strict();
export type OrganizationOsTheme = z.infer<typeof OrganizationOsThemeSchema>;

export const DEFAULT_ORGANIZATION_OS_THEME: OrganizationOsTheme = {
	version: 1,
	light: {
		accent: "#7c3aed",
		background: "#fbfbfb",
		foreground: "#171717",
		contrast: 50,
	},
	dark: {
		accent: "#a68bff",
		background: "#030303",
		foreground: "#f5f5f5",
		contrast: 50,
	},
	uiFont: "tedix",
	codeFont: "tedix-mono",
};
