import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const getTedi = vi.fn();

vi.mock("./lib/api-client", () => ({
	getTediProfileApiClient: () => ({ tedis: { get: getTedi } }),
}));

const { resolveTediProfileAuth, tediProfileFailureResponse } =
	await import("./tedi-profile-auth");

const env = { API_SERVICE: {} as Fetcher };

afterEach(() => {
	getTedi.mockReset();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("resolveTediProfileAuth", () => {
	it("intersects a D1 scope ceiling and carries the exact endpoint ceiling", async () => {
		getTedi.mockResolvedValue({
			mcpCapabilityProfile: "org_admin",
			organizationId: "org-acme",
			toolPolicy: {
				mcpScopes: ["mcp:work.read", "platform:admin"],
				mcpEndpoints: ["support/get"],
			},
		});
		const auth = await resolveTediProfileAuth(env, "worker");
		expect(auth).toMatchObject({
			status: "active",
			scopes: ["mcp:work.read"],
			mcpEndpoints: ["support/get"],
		});
	});
	it("returns the live profile scopes and organization", async () => {
		getTedi.mockResolvedValue({
			mcpCapabilityProfile: "org_admin",
			organizationId: "org-acme",
		});

		const auth = await resolveTediProfileAuth(env, "tedi-1");

		expect(auth.status).toBe("active");
		if (auth.status !== "active") return;
		expect(auth.orgId).toBe("org-acme");
		expect(auth.scopes).toContain("connections.admin");
		expect(getTedi).toHaveBeenCalledWith({ tediId: "tedi-1" });
	});

	it("treats a deleted tedi as missing, not as the standard profile", async () => {
		getTedi.mockRejectedValue({ code: "NOT_FOUND", status: 404 });

		await expect(resolveTediProfileAuth(env, "tedi-gone")).resolves.toEqual({
			status: "missing",
		});
		expect(getTedi).toHaveBeenCalledTimes(1);
	});

	it.each([
		[{ code: "INTERNAL_SERVER_ERROR", status: 500 }, "INTERNAL_SERVER_ERROR"],
		[new TypeError("network down"), "UNKNOWN"],
		[{ status: 503 }, "HTTP_503"],
	])("reports lookup failure %# as unavailable", async (error, code) => {
		getTedi.mockRejectedValue(error);

		await expect(resolveTediProfileAuth(env, "tedi-1")).resolves.toEqual({
			status: "unavailable",
			errorCode: code,
		});
	});

	it.each([
		{ status: 503 },
		{ code: "INTERNAL_SERVER_ERROR", status: 500 },
		Object.assign(new Error("Network connection lost."), { retryable: true }),
	])(
		"recovers a transient profile read without widening authority: %s",
		async (error) => {
			getTedi.mockRejectedValueOnce(error).mockResolvedValue({
				mcpCapabilityProfile: "org_admin",
				organizationId: "org-acme",
				toolPolicy: {
					mcpScopes: ["mcp:work.read"],
					mcpEndpoints: ["work/get"],
				},
			});

			await expect(resolveTediProfileAuth(env, "tedi-1")).resolves.toEqual({
				status: "active",
				scopes: ["mcp:work.read"],
				orgId: "org-acme",
				mcpEndpoints: ["work/get"],
			});
			expect(getTedi.mock.calls).toEqual([
				[{ tediId: "tedi-1" }],
				[{ tediId: "tedi-1" }],
			]);
		},
	);

	it("caps persistent outages at two profile reads", async () => {
		getTedi.mockRejectedValue({ status: 503 });
		await expect(resolveTediProfileAuth(env, "tedi-1")).resolves.toEqual({
			status: "unavailable",
			errorCode: "HTTP_503",
		});
		expect(getTedi).toHaveBeenCalledTimes(2);
	});

	it("bounds hung profile reads without granting scopes", async () => {
		vi.useFakeTimers();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		getTedi.mockImplementation(() => new Promise(() => {}));
		const result = resolveTediProfileAuth(env, "tedi-1");
		await vi.advanceTimersByTimeAsync(24_150);
		await expect(result).resolves.toEqual({
			status: "unavailable",
			errorCode: "GATEWAY_TIMEOUT",
		});
		expect(getTedi).toHaveBeenCalledTimes(2);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([
		[{ code: "UNAUTHORIZED" }, "UNAUTHORIZED"],
		[{ code: "FORBIDDEN" }, "FORBIDDEN"],
		[{ status: 401, retryable: true }, "HTTP_401"],
		[{ status: 403, retryable: true }, "HTTP_403"],
	])("does not retry denied identity: %s", async (error, code) => {
		getTedi
			.mockRejectedValueOnce(error)
			.mockResolvedValue({ mcpCapabilityProfile: "org_admin" });
		await expect(resolveTediProfileAuth(env, "tedi-1")).resolves.toEqual({
			status: "denied",
			errorCode: code,
		});
		expect(getTedi).toHaveBeenCalledTimes(1);
	});

	it("honors revocation on the retry and on the next request", async () => {
		getTedi
			.mockRejectedValueOnce({ status: 503 })
			.mockRejectedValue({ code: "NOT_FOUND", status: 404 });
		await expect(resolveTediProfileAuth(env, "tedi-1")).resolves.toEqual({
			status: "missing",
		});
		expect(getTedi).toHaveBeenCalledTimes(2);
		await expect(resolveTediProfileAuth(env, "tedi-1")).resolves.toEqual({
			status: "missing",
		});
		expect(getTedi).toHaveBeenCalledTimes(3);
	});

	it("is unavailable without an API binding instead of granting scopes", async () => {
		await expect(resolveTediProfileAuth({}, "tedi-1")).resolves.toEqual({
			status: "unavailable",
			errorCode: "API_SERVICE_UNBOUND",
		});
		expect(getTedi).not.toHaveBeenCalled();
	});
});

describe("tediProfileFailureResponse", () => {
	it("denies a missing tedi with 403", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const response = tediProfileFailureResponse(
			{ status: "missing" },
			"direct-tedi-jwt",
		);

		expect(response.status).toBe(403);
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		await expect(response.json()).resolves.toMatchObject({
			error: "tedi_inactive",
		});
		expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
			event: "tedi_profile_validation_failed",
			outcome: "missing",
			credentialMode: "direct-tedi-jwt",
		});
	});

	it("answers denied validation with a non-retryable 403", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const response = tediProfileFailureResponse(
			{ status: "denied", errorCode: "FORBIDDEN" },
			"delegated-mcp",
		);
		expect(response.status).toBe(403);
		expect(response.headers.has("Retry-After")).toBe(false);
		await expect(response.json()).resolves.toMatchObject({
			error: "tedi_validation_denied",
		});
	});

	it("answers an unavailable lookup with a retryable 503", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const response = tediProfileFailureResponse(
			{ status: "unavailable", errorCode: "HTTP_503" },
			"aih-m2m",
		);

		expect(response.status).toBe(503);
		expect(response.headers.get("Retry-After")).toBeTruthy();
		await expect(response.json()).resolves.toMatchObject({
			error: "tedi_validation_unavailable",
		});
	});
});
