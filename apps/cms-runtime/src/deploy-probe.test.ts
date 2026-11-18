import { describe, expect, it, vi } from "vite-plus/test";
import { serveCmsDeployProbe } from "./deploy-probe";
import { publicAssetCacheEligible } from "./tenant-public-cache";
import { pageCacheEligible } from "./tenant-page-cache";
const request = new Request(
	"https://site.test/?_tedix_deploy=job&_tedix_version=7&_tedix_etag=candidate",
);
const bundle = { version: 7, etag: "candidate" };
describe("deploy probe runtime", () => {
	it("bypasses both page and static/image response caches", () => {
		for (const path of ["/", "/_astro/app.css", "/_image"]) {
			const url = new URL(request.url);
			url.pathname = path;
			const probe = new Request(url);
			expect(publicAssetCacheEligible(probe)).toBe(false);
			expect(pageCacheEligible(probe, path)).toBe(false);
		}
	});
	it("attests the active candidate and forces no-store", async () => {
		const response = await serveCmsDeployProbe(
			request,
			bundle,
			async () => bundle,
			async () => new Response("page"),
		);
		expect(response.headers.get("X-Tedix-Bundle-Version")).toBe("7");
		expect(response.headers.get("X-Tedix-Bundle-Etag")).toBe("candidate");
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(await response.text()).toBe("page");
	});
	it("fails before dispatch when the candidate differs", async () => {
		const serve = vi.fn(async () => new Response("page"));
		expect(
			(
				await serveCmsDeployProbe(
					request,
					{ ...bundle, version: 8 },
					async () => bundle,
					serve,
				)
			).status,
		).toBe(409);
		expect(serve).not.toHaveBeenCalled();
	});
	it("fails when activation changes during the request", async () => {
		expect(
			(
				await serveCmsDeployProbe(
					request,
					bundle,
					async () => ({ ...bundle, etag: "new" }),
					async () => new Response("page"),
				)
			).status,
		).toBe(409);
	});
});
