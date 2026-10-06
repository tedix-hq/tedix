/** Use explicit locale routes instead of Astro's redirect fallback routes. */
export function rewriteTenantLocaleConfig(
	content: string,
	locale: string,
): string {
	const withDefaultLocale = content.replace(
		/^(\t+)defaultLocale:\s*["'][^"']+["']/m,
		`$1defaultLocale: "${locale}"`,
	);
	return withDefaultLocale.replace(/fallback:\s*\{[^}]*\}/, "fallback: {}");
}
