import { describe, expect, it } from "vite-plus/test";
import worker from "./worker-app";

const env = {
	API_URL: "https://api.tedi.club/",
} as CloudflareEnv;
const ctx = {} as ExecutionContext;

describe("public API discovery routes", () => {
	it("returns canonical catalog URLs and Link discovery from the API root", async () => {
		const response = await worker.fetch(
			new Request("https://untrusted.example/"),
			env,
			ctx,
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("Link")).toContain(
			'<https://api.tedi.club/openapi.json>; rel="service-desc"',
		);
		expect(await response.json()).toEqual({
			name: "Tedix API",
			openapi: "https://api.tedi.club/openapi.json",
			documentation: "https://api.tedi.club/docs",
		});
	});

	it("publishes an absolute HTML service-description link", async () => {
		const response = await worker.fetch(
			new Request("https://api.tedi.club/docs"),
			env,
			ctx,
		);
		const html = await response.text();

		expect(response.status).toBe(200);
		expect(response.headers.get("Link")).toContain(
			'<https://api.tedi.club/docs>; rel="service-doc"',
		);
		expect(html).toContain(
			'rel="service-desc" type="application/vnd.oai.openapi+json;version=3.1" href="https://api.tedi.club/openapi.json"',
		);
	});
});
