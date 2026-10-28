import assert from "node:assert/strict";
import type { Page } from "playwright";
import { handleOsRequest } from "../src/worker";

/** Exercise the production tenant document gate and headers, which Vite omits. */
export async function routeSandboxProxy(page: Page) {
	await page.route("**/sandbox_proxy*", async (route) => {
		const url = new URL(route.request().url());
		url.host = "acme.os.tedix.dev";
		url.protocol = "https:";
		const response = await handleOsRequest(
			new Request(url, {
				headers: { Accept: "text/html", "Sec-Fetch-Dest": "iframe" },
			}),
			{
				ASSETS: {
					fetch: async () =>
						new Response(
							await Bun.file(
								new URL("../public/sandbox_proxy.html", import.meta.url),
							).text(),
							{
								headers: { "Content-Type": "text/html" },
							},
						),
				},
				API_SERVICE: {
					fetch: async () => {
						throw new Error("Static proxy must not read tenant data");
					},
				},
			},
			async () => ({ provisioned: true, descopeTenantId: "fictional-tenant" }),
		);
		assert.equal(
			response.status,
			200,
			"signed-out proxy must not redirect to sign-in",
		);
		await route.fulfill({
			status: response.status,
			headers: Object.fromEntries(response.headers),
			body: await response.text(),
		});
	});
}
