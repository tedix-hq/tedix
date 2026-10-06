/**
 * App Theme utilities for Astro
 *
 * Port of AppThemeLayout functionality:
 * 1. Parse X-Tedix-App-Theme header (preferred) or fetch from API (fallback)
 * 2. Generate OKLCH CSS variables from branding
 * 3. Return data for SSR injection
 *
 * Widget Theming Flow:
 * - MCP server passes app branding via X-Tedix-App-Theme header
 * - Widget server reads header and injects CSS variables at SSR time
 * - This avoids FOUC and extra API calls on each widget render
 * - If header is missing, falls back to API fetch (for direct widget access)
 */

import {
	getApiClient,
	type RouterContractClient,
} from "@tedix/api-client/client";
import type { ApiContract } from "@tedix/api-contract/contracts/api";
import type { AppBranding } from "@tedix/api-contract/schemas/app";
import {
	mapAppBrandingToProfile,
	type WidgetThemePayload,
} from "@tedix/api-contract/schemas/widget-theme";
import {
	type BrandingProfile,
	generateBrandThemeCss,
	hasBrandingData,
} from "@tedix/widget-ui/theme";

/**
 * Validate if a string is a valid app slug format
 * App slugs must be lowercase alphanumeric with hyphens, 2-50 chars
 * Cannot start with special characters like @ or _
 */
export function isValidAppSlug(slug: string): boolean {
	// Must be 2-50 characters, lowercase alphanumeric with hyphens
	// Cannot start with @ (Vite paths), _ (private), or other special chars
	return /^[a-z][a-z0-9-]{1,49}$/.test(slug);
}

export interface AppData {
	id: string;
	name: string;
	slug: string;
	primaryDomain?: string;
	description?: string;
	logoUrl?: string;
	branding?: BrandingProfile;
	widgetConfig?: {
		locale?: string;
		currency?: string;
		gridColumns?: number;
	};
}

/**
 * Parse X-Tedix-App-Theme header and convert to AppData
 *
 * The header contains a JSON-encoded WidgetThemePayload with:
 * - id, slug, name: App identifiers
 * - branding: BrandingProfile (flat format for CSS variables)
 * - widgetConfig: Optional widget-specific configuration
 *
 * @param headerValue - Raw header value from X-Tedix-App-Theme
 * @returns AppData or null if parsing fails
 */
export function parseAppThemeHeader(
	headerValue: string | null,
): AppData | null {
	if (!headerValue) {
		return null;
	}

	try {
		const payload = JSON.parse(headerValue) as WidgetThemePayload;

		// Validate required fields
		if (!payload.id || !payload.slug || !payload.name) {
			console.warn("[AppTheme] Invalid theme payload: missing required fields");
			return null;
		}

		// Convert BrandingProfile (flat) to AppData.branding format
		// BrandingProfile uses flat keys: primaryColor, secondaryColor, etc.
		// AppData.branding expects the same flat format
		const appData: AppData = {
			id: payload.id,
			name: payload.name,
			slug: payload.slug,
			branding: payload.branding,
			widgetConfig: payload.widgetConfig as AppData["widgetConfig"],
		};

		return appData;
	} catch (error) {
		console.error(
			"[AppTheme] Failed to parse X-Tedix-App-Theme header:",
			error,
		);
		return null;
	}
}

/**
 * Get app data from request, preferring header over API
 *
 * Priority:
 * 1. X-Tedix-App-Theme header (from MCP server)
 * 2. API fetch (fallback for direct widget access)
 *
 * @param request - Astro request object (for header access)
 * @param appSlug - App slug for API fallback
 * @param apiUrl - API URL for fallback fetch
 */
export async function getAppDataFromRequest(
	request: Request,
	appSlug: string,
	apiUrl: string,
): Promise<AppData | null> {
	// Try header first (preferred - no extra API call)
	const headerValue = request.headers.get("X-Tedix-App-Theme");
	const headerData = parseAppThemeHeader(headerValue);

	if (headerData) {
		// Validate header slug matches request slug
		if (headerData.slug !== appSlug) {
			console.warn(
				`[AppTheme] Header slug mismatch: header=${headerData.slug}, request=${appSlug}`,
			);
			// Fall through to API fetch
		} else {
			return headerData;
		}
	}

	// Fallback to API fetch
	return fetchAppData(appSlug, apiUrl);
}

/**
 * Fetch app data from backend API using app slug
 * Uses Cloudflare Cache API with time-based cache keys (5-min buckets)
 */
export async function fetchAppData(
	appSlug: string,
	apiUrl: string,
): Promise<AppData | null> {
	try {
		// Create typed oRPC client
		const client = getApiClient<ApiContract>(apiUrl);

		// Call oRPC endpoint - returns app object directly
		const result = await client.apps.getBySlug({ slug: appSlug });

		// Transform oRPC response to AppData format
		// IMPORTANT: Must transform branding from AppBranding (nested DB format)
		// to BrandingProfile (flat widget format) using mapAppBrandingToProfile
		const brandingProfile = mapAppBrandingToProfile(
			result.metadata?.branding as AppBranding | null | undefined,
		);

		const appData: AppData = {
			id: result.id,
			name: result.name,
			slug: result.slug,
			primaryDomain: result.primaryDomain ?? undefined,
			description: result.description ?? undefined,
			logoUrl: result.logoUrl ?? undefined,
			branding: brandingProfile,
			widgetConfig: undefined, // Not in standard schema
		};

		return appData;
	} catch (error) {
		console.error(`[AppTheme] Error fetching app data for ${appSlug}:`, error);
		return null;
	}
}

/**
 * Generate CSS for app branding
 */
export function generateAppCss(appData: AppData | null): string {
	if (appData?.branding && hasBrandingData(appData.branding)) {
		return generateBrandThemeCss(appData.branding);
	}
	return "";
}
