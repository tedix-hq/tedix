import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("./registry", () => ({
	getBuild: vi.fn(),
	getSiteById: vi.fn(),
}));

import { getBuild, getSiteById } from "./registry";
import { serveDocsPreview } from "./preview";

describe("Docs preview entry alias", () => {
	beforeEach(() => {
		vi.mocked(getBuild).mockResolvedValue({
			id: "build-1",
			siteId: "site-1",
			status: "complete",
		} as never);
		vi.mocked(getSiteById).mockResolvedValue({
			id: "site-1",
			orgSlug: "acme",
		} as never);
	});

	it("redirects the metadata-selected alias to the preview root", async () => {
		const get = vi.fn(async (key: string) =>
			key.endsWith("/manifest.json")
				? { json: async () => ({ entryPath: "/readme" }) }
				: null,
		);
		const response = await serveDocsPreview({
			buildId: "build-1",
			env: { DB: {}, DOCS_BUILDS: { get } } as never,
			orgSlug: "acme",
			pathname: "/readme",
			request: new Request(
				"https://docs-admin.example/preview/build-1/readme?draft=1",
			),
		});

		expect(response.status).toBe(308);
		expect(response.headers.get("Location")).toBe(
			"https://docs-admin.example/preview/build-1/?draft=1",
		);
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		expect(response.headers.get("X-Robots-Tag")).toBe(
			"noindex, nofollow, noarchive",
		);
	});

	it("continues serving the machine-readable twin", async () => {
		const body = "# README";
		const get = vi.fn(async (key: string) => {
			if (key.endsWith("/manifest.json")) {
				return { json: async () => ({ entryPath: "/readme" }) };
			}
			if (key.endsWith("/readme/index.md")) {
				return {
					body,
					writeHttpMetadata() {},
				};
			}
			return null;
		});
		const response = await serveDocsPreview({
			buildId: "build-1",
			env: { DB: {}, DOCS_BUILDS: { get } } as never,
			orgSlug: "acme",
			pathname: "/readme.md",
			request: new Request(
				"https://docs-admin.example/preview/build-1/readme.md",
			),
		});

		expect(response.status).toBe(200);
		expect(await response.text()).toBe(body);
	});
});
