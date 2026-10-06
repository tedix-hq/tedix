import { AGENT_CARD_PATH } from "./agent-card";

const OPENAPI_MEDIA_TYPE = "application/vnd.oai.openapi+json;version=3.1";

function resolveApiOrigin(siteOrigin: string, apiUrl: string | URL): string {
	if (URL.canParse(apiUrl)) return new URL(apiUrl).origin;

	const fallback = new URL(siteOrigin);
	fallback.hostname = `api.${fallback.hostname.replace(/^www\./, "")}`;
	fallback.port = "";
	return fallback.origin;
}

export function getLandingAgentDiscoveryLinkHeader(
	siteUrl: string | URL,
	apiUrl: string | URL,
): string {
	const siteOrigin = new URL(siteUrl).origin;
	const apiOrigin = resolveApiOrigin(siteOrigin, apiUrl);
	return [
		`<${siteOrigin}${AGENT_CARD_PATH}>; rel="service-desc"; type="application/a2a+json"`,
		`<${apiOrigin}/openapi.json>; rel="service-desc"; type="${OPENAPI_MEDIA_TYPE}"`,
		`<${apiOrigin}/docs>; rel="service-doc"; type="text/html"`,
	].join(", ");
}

export function withLandingAgentDiscoveryLinks(
	response: Response,
	siteUrl: string | URL,
	apiUrl: string | URL,
): Response {
	const headers = new Headers(response.headers);
	headers.append("Link", getLandingAgentDiscoveryLinkHeader(siteUrl, apiUrl));
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
