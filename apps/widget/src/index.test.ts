import { describe, expect, it, vi } from "vite-plus/test";
import { createWidgetHandler } from "./index";

function handler(status = 200) {
	return createWidgetHandler({
		GIT_SHA: "0123456789abcdef",
		ASSETS: {
			fetch: vi.fn(
				async () =>
					new Response("embed", {
						status,
						headers: {
							"Content-Type": "application/javascript",
							"Cache-Control": "public, max-age=31536000, immutable",
						},
					}),
			),
		} as unknown as Fetcher,
	});
}

describe("white-label widget Worker", () => {
	it.each([404, 410, 500, 503])(
		"never caches a %s asset failure",
		async (status) => {
			for (const method of ["GET", "HEAD"]) {
				for (const path of [
					`/v1/embed.${"a".repeat(64)}.js`,
					`/v1/loader.${"b".repeat(64)}.js`,
					"/v1/manifest.json",
					"/embed.js",
					"/other.js",
				]) {
					const response = await handler(status)(
						new Request(`https://widget.tedix.dev${path}`, { method }),
					);
					expect(response.status).toBe(status);
					expect(response.headers.get("Cache-Control")).toBe("no-store");
					expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
					expect(response.headers.get("X-Content-Type-Options")).toBe(
						"nosniff",
					);
				}
			}
		},
	);

	it("keeps the bare origin non-browsable", async () => {
		const response = await handler()(new Request("https://widget.tedix.dev/"));
		expect(response.status).toBe(404);
		expect(await response.text()).toBe("");
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(response.headers.get("X-Robots-Tag")).toBe(
			"noindex, nofollow, noarchive",
		);
	});

	it("reports its exact deployed SHA", async () => {
		const response = await handler()(
			new Request("https://widget.tedix.dev/health"),
		);
		expect(await response.json()).toEqual({
			status: "ok",
			deployedSha: "0123456789abcdef",
		});
	});

	it("revalidates the mutable v1 alias before selecting a bundle", async () => {
		const response = await handler()(
			new Request("https://widget.tedix.dev/v1/embed.js"),
		);
		expect(await response.text()).toBe("embed");
		expect(response.headers.get("Cache-Control")).toBe("no-cache");
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
		expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe(
			"cross-origin",
		);
	});

	it("reserves immutable caching for content-addressed bundles", async () => {
		const digest = "a".repeat(64);
		const response = await handler()(
			new Request(`https://widget.tedix.dev/v1/embed.${digest}.js`),
		);
		expect(response.headers.get("Cache-Control")).toBe(
			"public, max-age=31536000, immutable",
		);
	});

	it("revalidates the mutable manifest before selecting a bundle", async () => {
		const response = await handler()(
			new Request("https://widget.tedix.dev/v1/manifest.json"),
		);
		expect(response.headers.get("Cache-Control")).toBe("no-cache");
	});

	it("also treats content-addressed loaders as immutable", async () => {
		const digest = "b".repeat(64);
		const response = await handler()(
			new Request(`https://widget.tedix.dev/v1/loader.${digest}.js`),
		);
		expect(response.headers.get("Cache-Control")).toBe(
			"public, max-age=31536000, immutable",
		);
	});

	it("does not make lookalike bundle paths immutable", async () => {
		const response = await handler()(
			new Request("https://widget.tedix.dev/v1/embed.latest.js"),
		);
		expect(response.headers.get("Cache-Control")).toBe(
			"public, max-age=300, s-maxage=300",
		);
	});

	it("revalidates the stable alias before serving a runtime", async () => {
		const response = await handler()(
			new Request("https://widget.tedix.dev/embed.js"),
		);
		expect(response.headers.get("Cache-Control")).toBe("no-cache");
	});

	it("revalidates the mutable loader aliases", async () => {
		for (const path of ["/loader.js", "/v1/loader.js"]) {
			const response = await handler()(
				new Request(`https://widget.tedix.dev${path}`),
			);
			expect(response.headers.get("Cache-Control")).toBe("no-cache");
		}
	});
});
