import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { syncConnectionProviderScopes } from "./connections";

const env = {
	DESCOPE_PROJECT_ID: "project",
	DESCOPE_MANAGEMENT_KEY: "test-key",
	DESCOPE_BASE_URL: "https://auth.example.com",
};
afterEach(() => vi.restoreAllMocks());

describe("provider scope reconciliation", () => {
	it("dry-runs without writing", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({
				app: { id: "mail", name: "Mail", defaultScopes: ["old"] },
			}),
		);
		expect(await syncConnectionProviderScopes("mail", ["new"], env)).toEqual({
			before: ["old"],
			after: ["new"],
			changed: true,
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("GET");
	});

	it("preserves the full app, verifies readback, and skips an identical set", async () => {
		let app = {
			id: "mail",
			name: "Mail",
			clientId: "client",
			clientSecret: "test-secret",
			useDcr: false,
			defaultScopes: ["old"],
		};
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async (_url, init) => {
				if (init?.method === "POST") {
					const body = JSON.parse(String(init.body)).app;
					expect(body).toEqual({ ...app, defaultScopes: ["new", "openid"] });
					app = body;
				}
				return Response.json({ app });
			});
		expect(
			(
				await syncConnectionProviderScopes(
					"mail",
					["openid", "new", "new"],
					env,
					false,
				)
			).changed,
		).toBe(true);
		expect(
			(
				await syncConnectionProviderScopes(
					"mail",
					["new", "openid"],
					env,
					false,
				)
			).changed,
		).toBe(false);
		expect(
			fetchMock.mock.calls.filter((call) => call[1]?.method === "POST"),
		).toHaveLength(1);
	});

	it("fails when Descope does not retain the requested scopes", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({
				app: { id: "mail", name: "Mail", defaultScopes: ["old"] },
			}),
		);
		await expect(
			syncConnectionProviderScopes("mail", ["new"], env, false),
		).rejects.toThrow("scope readback failed");
	});
});
