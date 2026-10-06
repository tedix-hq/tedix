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
});

describe("resolveTediProfileAuth", () => {
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
