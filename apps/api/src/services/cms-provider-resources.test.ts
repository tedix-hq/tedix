import { describe, expect, it, vi } from "vite-plus/test";
import { inspectCmsProviderResources } from "./cms-provider-resources";

describe("CMS provider resource inspection", () => {
	it("uses the internal CMS service to inspect Durable Object storage", async () => {
		const fetch = vi.fn().mockResolvedValue(
			Response.json({
				success: true,
				durableObject: { identifier: "EmDashDB:tenant", state: "present" },
			}),
		);
		const env = {
			CMS: { fetch },
			PLATFORM_SERVICE_TOKEN: "service-token",
		} as unknown as Parameters<typeof inspectCmsProviderResources>[0];
		await expect(
			inspectCmsProviderResources(env, "tenant"),
		).resolves.toMatchObject({
			durableObject: { state: "present" },
		});
		const request = fetch.mock.calls[0]?.[0] as Request;
		expect(request.url).toContain("/deployments/tenant/resources");
		expect(request.headers.get("X-Tedix-Connection-Label")).toBe("tenant");
	});

	it("reports storage state as unknown when provider service fails", async () => {
		const env = {
			CMS: { fetch: vi.fn().mockRejectedValue(new Error("unavailable")) },
			PLATFORM_SERVICE_TOKEN: "service-token",
		} as unknown as Parameters<typeof inspectCmsProviderResources>[0];
		await expect(
			inspectCmsProviderResources(env, "tenant"),
		).resolves.toMatchObject({
			durableObject: { state: "unknown", error: "unavailable" },
		});
	});
});
