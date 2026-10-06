import { describe, expect, it, vi } from "vite-plus/test";
import { getCatalogClient } from "./api";

describe("getCatalogClient", () => {
	it("delegates only the catalog read scope over the API service binding", async () => {
		const apiService = {
			fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const request =
					input instanceof Request ? input : new Request(input, init);
				expect(request.url).toBe("https://api/rpc/catalog/list");
				expect(request.headers.get("X-Service-Binding")).toBe("true");
				expect(request.headers.get("X-Tedix-Tedi-Scopes")).toBe("apps:read");
				return Response.json({
					json: {
						apps: [],
						total: 0,
						pagination: { limit: 1, offset: 0, hasMore: false },
					},
				});
			}),
		};

		const client = getCatalogClient({
			API_URL: "https://api.tedix.dev",
			API_SERVICE: apiService as unknown as Fetcher,
		});

		await expect(client.catalog.list({ limit: 1, offset: 0 })).resolves.toEqual(
			{
				apps: [],
				total: 0,
				pagination: { limit: 1, offset: 0, hasMore: false },
			},
		);
		expect(apiService.fetch).toHaveBeenCalledOnce();
	});
});
