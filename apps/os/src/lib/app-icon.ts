/**
 * One logo order for every app surface (Apps, Accounts, Browse, app detail):
 * the app's own logo, else the logo it inherits from its base app or catalog
 * entry, else its connection provider's logo, else its domain's favicon. When
 * every image is missing or fails to load, the caller shows a letter avatar.
 */
export type AppIconSource = {
	logoUrl?: string | null;
	inheritedLogoUrl?: string | null;
	providerLogoUrl?: string | null;
	domain?: string | null;
};

export function usableLogoUrl(
	logoUrl: string | null | undefined,
): string | null {
	if (!logoUrl) return null;
	const trimmed = logoUrl.trim();
	if (trimmed.startsWith("data:image/")) return trimmed;
	try {
		const parsed = new URL(trimmed);
		return parsed.protocol === "https:" || parsed.protocol === "http:"
			? parsed.toString()
			: null;
	} catch {
		return null;
	}
}

/** The same favicon service the catalog sync uses for apps without a logo. */
export function domainFaviconUrl(
	domain: string | null | undefined,
): string | null {
	const value = domain?.trim();
	if (!value) return null;
	try {
		const { hostname } = new URL(
			/^https?:\/\//i.test(value) ? value : `https://${value}`,
		);
		if (!hostname.includes(".")) return null;
		return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=128`;
	} catch {
		return null;
	}
}

/** Image URLs to try in order; empty means show the letter avatar. */
export function appIconCandidates(source: AppIconSource): string[] {
	const candidates = [
		usableLogoUrl(source.logoUrl),
		usableLogoUrl(source.inheritedLogoUrl),
		usableLogoUrl(source.providerLogoUrl),
		domainFaviconUrl(source.domain),
	].filter((url): url is string => url !== null);
	return [...new Set(candidates)];
}
