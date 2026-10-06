import { describe, expect, it, vi } from "vite-plus/test";
import { exchangeScanClientCredentials } from "./mcp-scan-auth.ts";

const TOKEN_URL = "https://cg.example.com/oauth2/token";
const CRED = "client-id:client-secret";

function mockFetch(impl: (url: string, init?: RequestInit) => Response) {
	return vi.fn(async (url: unknown, init?: unknown) =>
		impl(String(url), init as RequestInit | undefined),
	) as unknown as typeof fetch;
}

// Exchange mechanics (Basic header, grant body, failure taxonomy) are covered
// by the shared helper's tests in packages/mcp/src/auth/client-credentials.
// These pin the scan wrapper's contract: token-or-null, never throw.
describe("exchangeScanClientCredentials", () => {
	it("exchanges raw client_id:client_secret for a Bearer (Basic + grant_type)", async () => {
		let seenAuth: string | null = null;
		let seenBody: string | null = null;
		const fetchImpl = mockFetch((url, init) => {
			expect(url).toBe(TOKEN_URL);
			seenAuth = (init?.headers as Record<string, string>)?.Authorization;
			seenBody = init?.body as string;
			return new Response(
				JSON.stringify({ access_token: "fresh-bearer", expires_in: 3600 }),
				{
					status: 200,
				},
			);
		});

		const token = await exchangeScanClientCredentials(
			CRED,
			TOKEN_URL,
			fetchImpl,
		);

		expect(token).toBe("fresh-bearer");
		// Mirrors the runtime handler: HTTP Basic of the raw credential + bare grant.
		expect(seenAuth).toBe(`Basic ${btoa(CRED)}`);
		expect(seenBody).toBe("grant_type=client_credentials");
	});

	it("returns null (does not throw) on any exchange failure", async () => {
		const denied = mockFetch(
			() => new Response("invalid_client", { status: 401 }),
		);
		expect(await exchangeScanClientCredentials(CRED, TOKEN_URL, denied)).toBe(
			null,
		);

		const noToken = mockFetch(
			() =>
				new Response(JSON.stringify({ token_type: "Bearer" }), { status: 200 }),
		);
		expect(await exchangeScanClientCredentials(CRED, TOKEN_URL, noToken)).toBe(
			null,
		);

		const network = vi.fn(async () => {
			throw new Error("network down");
		}) as unknown as typeof fetch;
		expect(await exchangeScanClientCredentials(CRED, TOKEN_URL, network)).toBe(
			null,
		);
	});

	it("rejects SSRF-unsafe token URLs without sending a request", async () => {
		const fetchImpl = mockFetch(
			() =>
				new Response(JSON.stringify({ access_token: "t" }), { status: 200 }),
		);

		expect(
			await exchangeScanClientCredentials(
				CRED,
				"http://cg.example.com/token",
				fetchImpl,
			),
		).toBe(null);
		expect(
			await exchangeScanClientCredentials(
				CRED,
				"https://192.168.1.10/token",
				fetchImpl,
			),
		).toBe(null);
		expect(
			await exchangeScanClientCredentials(
				CRED,
				"https://api.tedix.dev/token",
				fetchImpl,
			),
		).toBe(null);
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});
