import { describe, expect, it, vi } from "vite-plus/test";
import { exchangeClientCredentials } from "./client-credentials";

const TOKEN_URL = "https://cg.example.com/oauth2/token";
const CRED = "client-id:client-secret";

function mockFetch(impl: (url: string, init?: RequestInit) => Response) {
	return vi.fn(async (url: string, init?: RequestInit) => impl(url, init));
}

describe("exchangeClientCredentials", () => {
	it("exchanges a raw client_id:client_secret string for a Bearer (Basic + grant_type)", async () => {
		let seenUrl: string | null = null;
		let seenAuth: string | null = null;
		let seenContentType: string | null = null;
		let seenBody: string | null = null;
		let seenRedirect: string | null = null;
		const fetchFn = mockFetch((url, init) => {
			seenUrl = url;
			const headers = init?.headers as Record<string, string>;
			seenAuth = headers?.Authorization ?? null;
			seenContentType = headers?.["Content-Type"] ?? null;
			seenBody = (init?.body as string) ?? null;
			seenRedirect = (init?.redirect as string) ?? null;
			return new Response(
				JSON.stringify({
					access_token: "fresh-bearer",
					expires_in: 3600,
					token_type: "Bearer",
				}),
				{ status: 200 },
			);
		});

		const result = await exchangeClientCredentials(CRED, TOKEN_URL, {
			fetchFn,
		});

		expect(result).toEqual({
			ok: true,
			token: {
				accessToken: "fresh-bearer",
				expiresInSeconds: 3600,
				tokenType: "Bearer",
			},
		});
		expect(seenUrl).toBe(TOKEN_URL);
		// Mirrors the runtime MCP handler: HTTP Basic of the raw credential + bare grant.
		expect(seenAuth).toBe(`Basic ${btoa(CRED)}`);
		expect(seenContentType).toBe("application/x-www-form-urlencoded");
		expect(seenBody).toBe("grant_type=client_credentials");
		expect(seenRedirect).toBe("manual");
	});

	it("builds the Basic credential from separate id/secret fields (secret may contain colons)", async () => {
		let seenAuth: string | null = null;
		const fetchFn = mockFetch((_url, init) => {
			seenAuth =
				(init?.headers as Record<string, string>)?.Authorization ?? null;
			return new Response(JSON.stringify({ access_token: "t" }), {
				status: 200,
			});
		});

		const result = await exchangeClientCredentials(
			{ clientId: "client-id", clientSecret: "secret:with:colons" },
			TOKEN_URL,
			{ fetchFn },
		);

		expect(result).toMatchObject({ ok: true });
		expect(seenAuth).toBe(`Basic ${btoa("client-id:secret:with:colons")}`);
	});

	it("url-encodes a custom grant type", async () => {
		let seenBody: string | null = null;
		const fetchFn = mockFetch((_url, init) => {
			seenBody = (init?.body as string) ?? null;
			return new Response(JSON.stringify({ access_token: "t" }), {
				status: 200,
			});
		});

		await exchangeClientCredentials(CRED, TOKEN_URL, {
			fetchFn,
			grantType: "urn:ietf:params:oauth:grant-type:jwt-bearer",
		});

		expect(seenBody).toBe(
			`grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}`,
		);
	});

	it("reports a non-2xx token response with the status and body excerpt", async () => {
		const fetchFn = mockFetch(
			() => new Response("invalid_client", { status: 401 }),
		);
		expect(
			await exchangeClientCredentials(CRED, TOKEN_URL, { fetchFn }),
		).toEqual({
			ok: false,
			error: "Token exchange failed (401): invalid_client",
		});
	});

	it("reports a 2xx response without access_token", async () => {
		const fetchFn = mockFetch(
			() =>
				new Response(JSON.stringify({ token_type: "Bearer" }), { status: 200 }),
		);
		expect(
			await exchangeClientCredentials(CRED, TOKEN_URL, { fetchFn }),
		).toEqual({
			ok: false,
			error: "Token exchange response missing access_token",
		});
	});

	it("reports (does not throw) when the token endpoint errors", async () => {
		const fetchFn = vi.fn(async () => {
			throw new Error("network down");
		});
		expect(
			await exchangeClientCredentials(CRED, TOKEN_URL, { fetchFn }),
		).toEqual({
			ok: false,
			error: "Token exchange error: network down",
		});
	});

	it("rejects SSRF-unsafe token URLs before any request is sent", async () => {
		const fetchFn = mockFetch(
			() =>
				new Response(JSON.stringify({ access_token: "t" }), { status: 200 }),
		);

		expect(
			await exchangeClientCredentials(CRED, "http://cg.example.com/token", {
				fetchFn,
			}),
		).toEqual({ ok: false, error: "Invalid token URL: URL must use HTTPS" });
		expect(
			await exchangeClientCredentials(CRED, "https://api.tedix.dev/token", {
				fetchFn,
			}),
		).toEqual({ ok: false, error: "Invalid token URL: Blocked host" });
		expect(
			await exchangeClientCredentials(CRED, "https://192.168.1.10/token", {
				fetchFn,
			}),
		).toEqual({
			ok: false,
			error: "Invalid token URL: Cannot connect to private networks",
		});
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("allows http token URLs only when the caller opts in (dev)", async () => {
		const fetchFn = mockFetch(
			() =>
				new Response(JSON.stringify({ access_token: "dev-token" }), {
					status: 200,
				}),
		);

		const result = await exchangeClientCredentials(
			CRED,
			"http://cg.example.com/token",
			{
				fetchFn,
				ssrf: { allowHttp: true },
			},
		);

		expect(result).toMatchObject({
			ok: true,
			token: { accessToken: "dev-token" },
		});
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});
});
