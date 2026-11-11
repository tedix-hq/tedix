import { describe, expect, it } from "vite-plus/test";
import { applyEdgeResponseHeaders } from "./public-proxy";

type Org = Parameters<typeof applyEdgeResponseHeaders>[2];
const org = {
	id: "org-1",
	slug: "acme",
	customDomain: "www.example.com",
} as unknown as Org;

function media(path: string) {
	return applyEdgeResponseHeaders(
		new Response("x", {
			headers: {
				"Content-Type": "application/octet-stream",
				"Content-Disposition": "attachment",
				"Content-Security-Policy": "sandbox",
			},
		}),
		"www.example.com",
		org,
		path,
	).headers;
}

describe("media file response headers", () => {
	it("keeps an uploaded SVG sandboxed on the admin origin", () => {
		const headers = media("/_emdash/api/media/file/logo.SVG");
		expect(headers.get("Content-Type")).toBe("image/svg+xml");
		const csp = headers.get("Content-Security-Policy") ?? "";
		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain("sandbox");
		expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
	});

	it("still serves raster images inline", () => {
		const headers = media("/_emdash/api/media/file/photo.png");
		expect(headers.get("Content-Type")).toBe("image/png");
		expect(headers.get("Content-Disposition")).toBeNull();
		expect(headers.get("Content-Security-Policy")).toBeNull();
	});
});
