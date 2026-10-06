/**
 * Extract domain from URL or domain string
 * Removes protocol, www prefix, and any path segments
 *
 * Examples:
 * - "https://www.mediamarkt.de" -> "mediamarkt.de"
 * - "www.mobile.de" -> "mobile.de"
 * - "kleinanzeigen.de/path" -> "kleinanzeigen.de"
 *
 * @param url - URL or domain string to extract from
 * @returns Clean domain without protocol, www, or paths
 */
export function getDomain(url: string): string {
	try {
		const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
		return parsed.hostname.replace(/^www\./, "");
	} catch {
		// Fallback: clean up string directly if URL parsing fails
		return url
			.replace(/^(https?:\/\/)?(www\.)?/, "")
			.replace(/\/.*$/, "")
			.toLowerCase();
	}
}
