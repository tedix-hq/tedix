import { describe, expect, it } from "vite-plus/test";
import {
	getApiDiscoveryLinkHeader,
	getApiDiscoveryUrls,
	renderApiReferenceHtml,
} from "./api-discovery";

describe("public API discovery", () => {
	it.each([
		["https://api.tedix.dev", "https://api.tedix.dev"],
		["https://api.tedi.club/", "https://api.tedi.club"],
		["http://localhost:8787/nested?ignored=1", "http://localhost:8787"],
	])(
		"keeps discovery URLs on the configured canonical host",
		(apiUrl, origin) => {
			expect(getApiDiscoveryUrls(apiUrl)).toEqual({
				origin,
				openapi: `${origin}/openapi.json`,
				documentation: `${origin}/docs`,
			});
		},
	);

	it("advertises the registered service description and documentation relations", () => {
		const header = getApiDiscoveryLinkHeader("https://api.tedix.dev/");

		expect(header).toContain(
			'<https://api.tedix.dev/openapi.json>; rel="service-desc"',
		);
		expect(header).toContain(
			'<https://api.tedix.dev/docs>; rel="service-doc"; type="text/html"',
		);
	});

	it("renders canonical absolute discovery links in the HTML reference", () => {
		const html = renderApiReferenceHtml({
			apiUrl: "https://api.tedi.club/",
			faviconHref: "https://tedi.club/favicon.ico",
		});

		expect(html).toContain(
			'<link rel="canonical" href="https://api.tedi.club/docs" />',
		);
		expect(html).toContain(
			'rel="service-desc" type="application/vnd.oai.openapi+json;version=3.1" href="https://api.tedi.club/openapi.json"',
		);
		expect(html).toContain(
			'<script id="api-reference" data-url="https://api.tedi.club/openapi.json">',
		);
	});
});
