import { describe, expect, it, vi } from "vite-plus/test";
import { resolveTediProfileAuth } from "./tedi-profile-auth";

function binding(fetch: Fetcher["fetch"]): Fetcher {
	return {
		fetch,
		connect: () => {
			throw new Error("Unexpected socket connection");
		},
	};
}

describe("tedi profile service-binding transport", () => {
	it("recovers a raw proxy 503 through the real oRPC link", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				new Response("API temporarily unavailable", { status: 503 }),
			)
			.mockResolvedValueOnce(
				Response.json({
					json: {
						mcpCapabilityProfile: "org_admin",
						organizationId: "org-acme",
						toolPolicy: {
							mcpScopes: ["mcp:work.read"],
							mcpEndpoints: ["work/get"],
						},
					},
				}),
			);
		await expect(
			resolveTediProfileAuth({ API_SERVICE: binding(fetch) }, "tedi-1"),
		).resolves.toEqual({
			status: "active",
			orgId: "org-acme",
			scopes: ["mcp:work.read"],
			mcpEndpoints: ["work/get"],
		});
		expect(fetch).toHaveBeenCalledTimes(2);
		for (const [request] of fetch.mock.calls) {
			expect(new URL(request.url).pathname).toBe("/rpc/tedis/get");
			expect(request.headers.get("X-Tedix-Org-Id")).toBe("system");
		}
	});

	it.each([401, 403, 404])(
		"does not retry raw HTTP %s as an outage",
		async (status) => {
			const fetch = vi.fn(
				async () => new Response("Identity denied", { status }),
			);
			await expect(
				resolveTediProfileAuth({ API_SERVICE: binding(fetch) }, "tedi-1"),
			).resolves.toEqual(
				status === 404
					? { status: "missing" }
					: { status: "denied", errorCode: `HTTP_${status}` },
			);
			expect(fetch).toHaveBeenCalledTimes(1);
		},
	);
});
