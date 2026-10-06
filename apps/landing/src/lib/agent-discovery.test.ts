import { describe, expect, it } from "vite-plus/test";
import {
	getLandingAgentDiscoveryLinkHeader,
	withLandingAgentDiscoveryLinks,
} from "./agent-discovery";

describe("landing Agent Readiness discovery", () => {
	it("advertises only deployed A2A, OpenAPI, and API documentation targets", () => {
		const header = getLandingAgentDiscoveryLinkHeader(
			"https://tedix.dev/nested",
			"https://api.tedix.dev/v1",
		);

		expect(header).toBe(
			'<https://tedix.dev/.well-known/agent-card.json>; rel="service-desc"; type="application/a2a+json", <https://api.tedix.dev/openapi.json>; rel="service-desc"; type="application/vnd.oai.openapi+json;version=3.1", <https://api.tedix.dev/docs>; rel="service-doc"; type="text/html"',
		);
	});

	it("derives the public API origin when an exported overlay hides its URL", () => {
		const header = getLandingAgentDiscoveryLinkHeader(
			"https://www.tedix.dev/nested",
			"configured-via-private-overlay",
		);

		expect(header).toContain(
			'<https://api.tedix.dev/openapi.json>; rel="service-desc"',
		);
		expect(header).toContain('<https://api.tedix.dev/docs>; rel="service-doc"');
	});

	it("preserves redirects and existing response links", () => {
		const response = withLandingAgentDiscoveryLinks(
			new Response(null, {
				status: 301,
				headers: {
					Link: '</styles.css>; rel="preload"',
					Location: "https://blog.tedix.dev/",
				},
			}),
			"https://tedix.dev",
			"https://api.tedix.dev",
		);

		expect(response.status).toBe(301);
		expect(response.headers.get("location")).toBe("https://blog.tedix.dev/");
		expect(response.headers.get("link")).toContain(
			'</styles.css>; rel="preload"',
		);
		expect(response.headers.get("link")).toContain(
			'<https://tedix.dev/.well-known/agent-card.json>; rel="service-desc"',
		);
	});
});
