import { describe, expect, it, vi } from "vite-plus/test";
import {
	inspectCmsMediaResource,
	repairCmsMediaResource,
} from "./cms-media-resources";

describe("CMS media resource service", () => {
	it("sends a trusted create or repair intent only on POST", async () => {
		const fetch = vi.fn(async () =>
			Response.json({
				success: true,
				bucketName: "tedix-cms-media-acme",
				created: false,
				exists: true,
			}),
		);
		const env = {
			CMS: { fetch },
			PLATFORM_SERVICE_TOKEN: "service-token",
		} as never;

		await inspectCmsMediaResource(env, "acme");
		await repairCmsMediaResource(
			env,
			"acme",
			"create",
			"11111111-1111-4111-8111-111111111111",
		);
		await repairCmsMediaResource(
			env,
			"acme",
			"repair",
			"11111111-1111-4111-8111-111111111111",
		);

		const requests = fetch.mock.calls.map(([request]) => request as Request);
		expect(requests.map((request) => request.method)).toEqual([
			"GET",
			"POST",
			"POST",
		]);
		expect(
			requests.map((request) =>
				request.headers.get("X-Tedix-CMS-Media-Intent"),
			),
		).toEqual([null, "create", "repair"]);
		for (const request of requests) {
			expect(request.url).toBe(
				"https://cms.internal/api/internal/deployments/acme/media",
			);
			expect(request.headers.get("Authorization")).toBe("Bearer service-token");
			expect(request.headers.get("X-Tedix-Connection-Label")).toBe("acme");
			if (request.method === "POST")
				expect(request.headers.get("X-Tedix-CMS-Site-Id")).toBe(
					"11111111-1111-4111-8111-111111111111",
				);
		}
	});
});
