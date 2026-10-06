import { decodeUnverifiedJwtClaims } from "./web.ts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
	logoutDescopeSession,
	readCookieHeader,
	resumeDescopeSession,
	selectDescopeTenantSession,
} from "./web.ts";

describe("readCookieHeader", () => {
	it("keeps the first value when duplicate cookie names are present", () => {
		expect(
			readCookieHeader("DS=host-session; DSR=refresh; DS=domain-session", "DS"),
		).toBe("host-session");
	});
});

describe("selectDescopeTenantSession", () => {
	it("posts tenant selection with the cookie-managed refresh contract and returns the minted JWTs", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						refreshJwt: "rotated-refresh",
						sessionJwt: "minted-session",
					}),
					{ headers: { "Content-Type": "application/json" }, status: 200 },
				),
		);

		const selected = await selectDescopeTenantSession({
			baseUrl: "https://auth.tedix.dev/",
			fetch: fetchMock as unknown as typeof fetch,
			projectId: "P-test",
			refreshToken: "refresh-token",
			tenantId: "org_tedix",
		});

		expect(selected).toEqual({
			refreshJwt: "rotated-refresh",
			sessionJwt: "minted-session",
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(url).toBe("https://auth.tedix.dev/v1/auth/tenant/select");
		expect(init.method).toBe("POST");
		expect(new Headers(init.headers).get("authorization")).toBe(
			"Bearer P-test",
		);
		expect(new Headers(init.headers).get("cookie")).toBe("DSR=refresh-token");
		expect(new Headers(init.headers).get("x-descope-refresh-cookie-name")).toBe(
			"DSR",
		);
		expect(init.body).toBe(JSON.stringify({ tenant: "org_tedix" }));
	});

	it("surfaces a rotated refresh token that arrives only as a Set-Cookie (cookie-managed projects)", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({ refreshJwt: "", sessionJwt: "minted-session" }),
					{
						headers: {
							"Content-Type": "application/json",
							"Set-Cookie":
								"DSR=rotated-via-cookie; Max-Age=2419200; Path=/; HttpOnly; Secure",
						},
						status: 200,
					},
				),
		);

		const selected = await selectDescopeTenantSession({
			baseUrl: "https://auth.tedix.dev",
			fetch: fetchMock as unknown as typeof fetch,
			projectId: "P-test",
			refreshToken: "consumed-refresh",
			tenantId: "org_tedix",
		});

		expect(selected).toEqual({
			refreshCookieMaxAge: 2_419_200,
			refreshJwt: "rotated-via-cookie",
			sessionJwt: "minted-session",
		});
	});

	it("returns null (never throws) on rejection, missing sessionJwt, and network failure", async () => {
		const rejected = vi.fn(
			async () => new Response(JSON.stringify({}), { status: 401 }),
		);
		expect(
			await selectDescopeTenantSession({
				baseUrl: "https://auth.tedix.dev",
				fetch: rejected as unknown as typeof fetch,
				projectId: "P-test",
				refreshToken: "bad",
				tenantId: "org_tedix",
			}),
		).toBeNull();

		const emptyBody = vi.fn(
			async () => new Response(JSON.stringify({}), { status: 200 }),
		);
		expect(
			await selectDescopeTenantSession({
				baseUrl: "https://auth.tedix.dev",
				fetch: emptyBody as unknown as typeof fetch,
				projectId: "P-test",
				refreshToken: "ok",
				tenantId: "org_tedix",
			}),
		).toBeNull();

		const network = vi.fn(async () => {
			throw new Error("network down");
		});
		expect(
			await selectDescopeTenantSession({
				baseUrl: "https://auth.tedix.dev",
				fetch: network as unknown as typeof fetch,
				projectId: "P-test",
				refreshToken: "ok",
				tenantId: "org_tedix",
			}),
		).toBeNull();
	});
});

describe("resumeDescopeSession", () => {
	it("refreshes the current selection and surfaces cookie-only rotation", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(JSON.stringify({ sessionJwt: "resumed-session" }), {
					headers: {
						"Content-Type": "application/json",
						"Set-Cookie":
							"DSR=resumed-refresh; Max-Age=600; Path=/; HttpOnly; Secure",
					},
					status: 200,
				}),
		);

		await expect(
			resumeDescopeSession({
				baseUrl: "https://auth.tedix.dev/",
				fetch: fetchMock as unknown as typeof fetch,
				projectId: "P-test",
				refreshToken: "current-refresh",
			}),
		).resolves.toEqual({
			refreshCookieMaxAge: 600,
			refreshJwt: "resumed-refresh",
			sessionJwt: "resumed-session",
		});
		const [url, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(url).toBe("https://auth.tedix.dev/v1/auth/refresh");
		expect(new Headers(init.headers).get("authorization")).toBe(
			"Bearer P-test",
		);
		expect(new Headers(init.headers).get("cookie")).toBe("DSR=current-refresh");
		expect(init.body).toBe("{}");
	});
});

describe("logoutDescopeSession", () => {
	it.each([
		[204, "revoked"],
		[401, "already_invalid"],
		[503, "unconfirmed"],
	] as const)(
		"maps HTTP %s to %s without exposing the refresh token",
		async (status, outcome) => {
			const fetchMock = vi.fn(async () => new Response(null, { status }));
			await expect(
				logoutDescopeSession({
					baseUrl: "https://auth.tedix.dev",
					fetch: fetchMock as unknown as typeof fetch,
					projectId: "P-test",
					refreshToken: "logout-refresh",
				}),
			).resolves.toBe(outcome);
			const [url, init] = fetchMock.mock.calls[0] as unknown as [
				string,
				RequestInit,
			];
			expect(url).toBe("https://auth.tedix.dev/v1/auth/logout");
			expect(new Headers(init.headers).get("authorization")).toBe(
				"Bearer P-test",
			);
			expect(new Headers(init.headers).get("cookie")).toBe(
				"DSR=logout-refresh",
			);
		},
	);
});

describe("decodeUnverifiedJwtClaims", () => {
	const jwt = (claims: Record<string, unknown>) =>
		`header.${btoa(JSON.stringify(claims))
			.replaceAll("+", "-")
			.replaceAll("/", "_")
			.replace(/=+$/, "")}.signature`;

	it("decodes base64url payloads without verification", () => {
		expect(
			decodeUnverifiedJwtClaims(jwt({ dct: "org_tedix", sub: "user-1" })),
		).toMatchObject({ dct: "org_tedix", sub: "user-1" });
	});

	it("returns null for absent, malformed, or non-object payloads", () => {
		expect(decodeUnverifiedJwtClaims(null)).toBeNull();
		expect(decodeUnverifiedJwtClaims(undefined)).toBeNull();
		expect(decodeUnverifiedJwtClaims("not-a-jwt")).toBeNull();
		expect(decodeUnverifiedJwtClaims("a.%%%.c")).toBeNull();
		expect(
			decodeUnverifiedJwtClaims(`a.${btoa('"just a string"')}.c`),
		).toBeNull();
	});
});
