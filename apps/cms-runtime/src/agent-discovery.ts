export interface CmsAgentDiscoverySite {
	publicSiteUrl: string;
	publicPathPrefix: string | null;
}

function canonicalPublicResourceUrl(
	site: CmsAgentDiscoverySite,
	pathname: string,
): string {
	const target = new URL(site.publicSiteUrl);
	const prefix = site.publicPathPrefix;
	target.pathname = prefix ? `${prefix}${pathname}` : pathname;
	target.search = "";
	target.hash = "";
	return target.toString();
}

export function getCmsAgentDiscoveryLinkHeader(
	site: CmsAgentDiscoverySite,
): string {
	return `<${canonicalPublicResourceUrl(site, "/llms.txt")}>; rel="service-desc"; type="text/plain"`;
}

export function withCmsAgentDiscoveryLinks(
	response: Response,
	site: CmsAgentDiscoverySite,
): Response {
	const headers = new Headers(response.headers);
	headers.append("Link", getCmsAgentDiscoveryLinkHeader(site));
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
