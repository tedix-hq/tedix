export const OPENAPI_MEDIA_TYPE =
	"application/vnd.oai.openapi+json;version=3.1";

export interface ApiDiscoveryUrls {
	origin: string;
	openapi: string;
	documentation: string;
}

export function getApiDiscoveryUrls(apiUrl: string): ApiDiscoveryUrls {
	const configured = new URL(apiUrl);
	configured.pathname = "/";
	configured.search = "";
	configured.hash = "";
	const origin = configured.origin;

	return {
		origin,
		openapi: `${origin}/openapi.json`,
		documentation: `${origin}/docs`,
	};
}

export function getApiDiscoveryLinkHeader(apiUrl: string): string {
	const urls = getApiDiscoveryUrls(apiUrl);
	return [
		`<${urls.openapi}>; rel="service-desc"; type="${OPENAPI_MEDIA_TYPE}"`,
		`<${urls.documentation}>; rel="service-doc"; type="text/html"`,
	].join(", ");
}

export function renderApiReferenceHtml(input: {
	apiUrl: string;
	faviconHref: string;
}): string {
	const urls = getApiDiscoveryUrls(input.apiUrl);
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<title>Tedix API Reference</title>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<link rel="icon" href="${input.faviconHref}" />
	<link rel="canonical" href="${urls.documentation}" />
	<link rel="service-desc" type="${OPENAPI_MEDIA_TYPE}" href="${urls.openapi}" title="Tedix OpenAPI 3.1" />
</head>
<body>
	<script id="api-reference" data-url="${urls.openapi}"></script>
	<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body>
</html>`;
}
