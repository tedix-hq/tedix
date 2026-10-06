/**
 * Widget Theme Schemas
 *
 * Canonical schemas for widget theming, bridging the gap between
 * the database schema (AppBranding) and the widget theming system (BrandingProfile).
 *
 * This module provides:
 * - BrandingProfileSchema: Flattened format for CSS variable generation
 * - WidgetThemePayloadSchema: Full payload sent in X-Tedix-App-Theme header
 * - mapAppBrandingToProfile: Canonical mapper from DB format to widget format
 */

import * as z from "zod";
import type { AppBranding } from "./app";
import { JsonValueSchema } from "./common";

// =============================================================================
// BRAND TYPOGRAPHY SCHEMA
// =============================================================================

/**
 * Typography configuration for widget theming
 */
export const BrandTypographySchema = z.object({
	/** Primary font family for the widget */
	fontFamily: z.string().optional(),
	/** Font families array (for font loading) */
	fonts: z.array(z.string()).optional(),
	/** Font family for headings */
	headingFont: z.string().optional(),
	/** Font family for body text */
	bodyFont: z.string().optional(),
});
export type BrandTypography = z.infer<typeof BrandTypographySchema>;

// =============================================================================
// BRANDING PROFILE SCHEMA
// =============================================================================

/**
 * Flattened branding profile for widget theming
 *
 * This is the canonical format consumed by:
 * - BrandThemeProvider (widget-ui)
 * - CSS variable generation (theme.ts)
 * - X-Tedix-App-Theme header payload
 *
 * Colors are flat properties (primaryColor, secondaryColor) rather than
 * nested (colors.primary, colors.secondary) for simpler CSS variable mapping.
 */
export const BrandingProfileSchema = z.object({
	/** Primary brand color (hex format, e.g., "#0051FF") */
	primaryColor: z.string().optional(),
	/** Secondary brand color */
	secondaryColor: z.string().optional(),
	/** Accent color for highlights and CTAs */
	accentColor: z.string().optional(),
	/** Background color for the widget */
	backgroundColor: z.string().optional(),
	/** Primary text color */
	textColor: z.string().optional(),
	/** Secondary text color (muted) */
	textSecondaryColor: z.string().optional(),
	/** Link color */
	linkColor: z.string().optional(),
	/** Success state color */
	successColor: z.string().optional(),
	/** Warning state color */
	warningColor: z.string().optional(),
	/** Error state color */
	errorColor: z.string().optional(),
	/** Primary brand color (dark mode) */
	primaryColorDark: z.string().optional(),
	/** Secondary brand color (dark mode) */
	secondaryColorDark: z.string().optional(),
	/** Accent color for highlights and CTAs (dark mode) */
	accentColorDark: z.string().optional(),
	/** Background color for the widget (dark mode) */
	backgroundColorDark: z.string().optional(),
	/** Primary text color (dark mode) */
	textColorDark: z.string().optional(),
	/** Secondary text color (muted) (dark mode) */
	textSecondaryColorDark: z.string().optional(),
	/** Link color (dark mode) */
	linkColorDark: z.string().optional(),
	/** Success state color (dark mode) */
	successColorDark: z.string().optional(),
	/** Warning state color (dark mode) */
	warningColorDark: z.string().optional(),
	/** Error state color (dark mode) */
	errorColorDark: z.string().optional(),
	/** Logo URL */
	logo: z.string().optional(),
	/** Favicon URL */
	favicon: z.string().optional(),
	/** OG Image URL */
	ogImage: z.string().optional(),
	/** Color scheme preference */
	colorScheme: z.enum(["light", "dark"]).optional(),
	/** Typography configuration */
	typography: BrandTypographySchema.optional(),
});
export type BrandingProfile = z.infer<typeof BrandingProfileSchema>;

// =============================================================================
// WIDGET THEME PAYLOAD SCHEMA
// =============================================================================

/**
 * Full widget theme payload sent via X-Tedix-App-Theme header
 *
 * Contains app identification plus branding for SSR theming.
 * The widget server receives this and injects CSS variables at render time.
 */
export const WidgetThemePayloadSchema = z.object({
	/** App UUID (primary identifier) */
	id: z.uuid(),
	/** App slug (for subdomain routing) */
	slug: z.string(),
	/** App display name */
	name: z.string(),
	/** Flattened branding profile for CSS variable generation */
	branding: BrandingProfileSchema,
	/** Optional widget-specific configuration overrides */
	widgetConfig: z.record(z.string(), JsonValueSchema).optional(),
});
export type WidgetThemePayload = z.infer<typeof WidgetThemePayloadSchema>;

// =============================================================================
// DEFAULT VALUES
// =============================================================================

/**
 * Default branding values when no branding is provided
 * These ensure widgets always have a sensible baseline theme
 */
export const DEFAULT_BRANDING_PROFILE: Required<
	Pick<
		BrandingProfile,
		"backgroundColor" | "textColor" | "typography" | "colorScheme"
	>
> = {
	backgroundColor: "#FFFFFF",
	textColor: "#1A1A1A",
	typography: {
		fontFamily: "Inter, system-ui, sans-serif",
	},
	colorScheme: "light",
};

// =============================================================================
// MAPPER FUNCTION
// =============================================================================

/**
 * Maps AppBranding (D1/API nested format) to BrandingProfile (widget flat format)
 *
 * This is the canonical mapper that should be used everywhere the conversion
 * is needed. Previously duplicated in:
 * - packages/widget-ui/src/lib/branding-mapper.ts
 * - apps/mcp/src/mcp/utils/widget.ts
 *
 * @param branding - AppBranding object from the API/database, can be undefined/null
 * @returns BrandingProfile with all required fields populated with defaults
 *
 * @example
 * ```typescript
 * import { mapAppBrandingToProfile } from "@tedix/api-contract/schemas/widget-theme";
 *
 * const appBranding = {
 *   logo: "https://example.com/logo.png",
 *   colors: { primary: "#0051FF", secondary: "#6B7280" },
 *   fonts: { heading: "Poppins", body: "Inter" },
 *   images: { logo: "https://example.com/logo-large.png", favicon: "/favicon.ico" }
 * };
 *
 * const profile = mapAppBrandingToProfile(appBranding);
 * // Returns:
 * // {
 * //   logo: "https://example.com/logo-large.png",
 * //   favicon: "/favicon.ico",
 * //   primaryColor: "#0051FF",
 * //   secondaryColor: "#6B7280",
 * //   backgroundColor: "#FFFFFF",
 * //   textColor: "#1A1A1A",
 * //   typography: {
 * //     fontFamily: "Inter",
 * //     headingFont: "Poppins",
 * //     bodyFont: "Inter"
 * //   },
 * //   colorScheme: "light"
 * // }
 * ```
 */
export function mapAppBrandingToProfile(
	branding?: AppBranding | null,
): BrandingProfile {
	// Return defaults if no branding provided
	if (!branding) {
		return {
			...DEFAULT_BRANDING_PROFILE,
		};
	}

	// Build typography from fonts
	const typography: BrandTypography = {
		fontFamily:
			branding.fonts?.body ||
			branding.fonts?.heading ||
			DEFAULT_BRANDING_PROFILE.typography.fontFamily,
	};

	// Add heading/body font if present
	if (branding.fonts?.heading) {
		typography.headingFont = branding.fonts.heading;
	}
	if (branding.fonts?.body) {
		typography.bodyFont = branding.fonts.body;
	}

	// Determine logo URL (prefer images.logo, fall back to top-level logo)
	const logo = branding.images?.logo || branding.logo || undefined;

	// Build the BrandingProfile
	// Note: Use `|| undefined` to coerce null (from DB .nullish()) to undefined
	const profile: BrandingProfile = {
		// Logo and favicon
		logo,
		favicon: branding.images?.favicon || undefined,
		ogImage: branding.images?.ogImage || undefined,

		// Core colors - map from nested colors object
		primaryColor: branding.colors?.primary || undefined,
		secondaryColor: branding.colors?.secondary || undefined,
		accentColor: branding.colors?.accent || undefined,

		// UI colors - use Firecrawl values or fallback to defaults
		backgroundColor:
			branding.colors?.background || DEFAULT_BRANDING_PROFILE.backgroundColor,
		textColor: branding.colors?.text || DEFAULT_BRANDING_PROFILE.textColor,
		textSecondaryColor: branding.colors?.textSecondary || undefined,
		linkColor: branding.colors?.link || undefined,

		// Semantic colors
		successColor: branding.colors?.success || undefined,
		warningColor: branding.colors?.warning || undefined,
		errorColor: branding.colors?.error || undefined,

		// Dark mode colors (optional)
		primaryColorDark: branding.colorsDark?.primary || undefined,
		secondaryColorDark: branding.colorsDark?.secondary || undefined,
		accentColorDark: branding.colorsDark?.accent || undefined,
		backgroundColorDark: branding.colorsDark?.background || undefined,
		textColorDark: branding.colorsDark?.text || undefined,
		textSecondaryColorDark: branding.colorsDark?.textSecondary || undefined,
		linkColorDark: branding.colorsDark?.link || undefined,
		successColorDark: branding.colorsDark?.success || undefined,
		warningColorDark: branding.colorsDark?.warning || undefined,
		errorColorDark: branding.colorsDark?.error || undefined,

		// Typography
		typography,

		// Color scheme - use Firecrawl value or default to light
		colorScheme: branding.colorScheme || DEFAULT_BRANDING_PROFILE.colorScheme,
	};

	return profile;
}
