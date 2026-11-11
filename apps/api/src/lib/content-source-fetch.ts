import { guardedFetch } from "@tedix/ssrf-guard";

/**
 * Fetch a URL a tenant configured as a content source (page, PDF, sitemap,
 * feed, and the links those documents name). A tenant may point at its own
 * Tedix-served site, never at a local or private address; every redirect hop
 * is checked again.
 */
export function fetchContentSource(
	url: string,
	init?: RequestInit,
): Promise<Response> {
	return guardedFetch(url, init, { allowHttp: true, allowTedixHosts: true });
}
