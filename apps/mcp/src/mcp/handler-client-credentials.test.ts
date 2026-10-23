import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { resolveClientCredentialsToken } from "./handler-connection-credentials";

const TOKEN_URL = "https://auth.example.com/oauth2/token";
const CRED = "client-id:client-secret";

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.useRealTimers();
});

function stubFetch(impl: (url: string, init?: RequestInit) => Response) {
	const fn = vi.fn(async (url: unknown, init?: unknown) =>
		impl(String(url), init as RequestInit | undefined),
	);
	globalThis.fetch = fn as unknown as typeof globalThis.fetch;
	return fn;
}

// The module-level credential cache has no test reset — every test uses its
// own cache key so entries can never leak across tests.
let keyCounter = 0;
function uniqueKey(): string {
	return `cc::test-tedi::conn::${TOKEN_URL}::${keyCounter++}`;
}

describe("resolveClientCredentialsToken", () => {
	it("exchanges the stored credential for a bearer over the Basic + grant_type wire format", async () => {
		const fetchSpy = stubFetch(() =>
			Response.json({ access_token: "bearer-1", expires_in: 3600 }),
		);

		const result = await resolveClientCredentialsToken(
			CRED,
			TOKEN_URL,
			"client_credentials",
			uniqueKey(),
			false,
		);

		expect(result).toEqual({ token: "bearer-1" });
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(TOKEN_URL);
		const headers = new Headers(init.headers);
		expect(headers.get("Authorization")).toBe(`Basic ${btoa(CRED)}`);
		expect(headers.get("Content-Type")).toBe(
			"application/x-www-form-urlencoded",
		);
		expect(init.body).toBe("grant_type=client_credentials");
		expect(init.redirect).toBe("manual");
	});

	it("caches the bearer by the server-reported TTL and re-exchanges after expiry", async () => {
		vi.useFakeTimers();
		const fetchSpy = stubFetch(() =>
			Response.json({ access_token: "bearer-ttl", expires_in: 120 }),
		);
		const cacheKey = uniqueKey();
		const resolve = () =>
			resolveClientCredentialsToken(
				CRED,
				TOKEN_URL,
				"client_credentials",
				cacheKey,
				false,
			);

		expect(await resolve()).toEqual({ token: "bearer-ttl" });
		expect(await resolve()).toEqual({ token: "bearer-ttl" });
		expect(fetchSpy).toHaveBeenCalledTimes(1);

		// expires_in 120s minus the 60s safety margin → cached for 60s.
		vi.advanceTimersByTime(61_000);
		expect(await resolve()).toEqual({ token: "bearer-ttl" });
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it("rejects SSRF-unsafe token URLs in prod without calling fetch", async () => {
		const fetchSpy = stubFetch(() =>
			Response.json({ access_token: "should-not-mint" }),
		);

		expect(
			await resolveClientCredentialsToken(
				CRED,
				"http://auth.example.com/token",
				"client_credentials",
				uniqueKey(),
				false,
			),
		).toEqual({ token: null, error: "Invalid token URL: URL must use HTTPS" });
		expect(
			await resolveClientCredentialsToken(
				CRED,
				"https://api.tedix.dev/token",
				"client_credentials",
				uniqueKey(),
				false,
			),
		).toEqual({ token: null, error: "Invalid token URL: Blocked host" });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("allows http token URLs in dev (allowHttp)", async () => {
		const fetchSpy = stubFetch(() =>
			Response.json({ access_token: "dev-bearer" }),
		);

		const result = await resolveClientCredentialsToken(
			CRED,
			"http://auth.example.com/token",
			"client_credentials",
			uniqueKey(),
			true,
		);

		expect(result).toEqual({ token: "dev-bearer" });
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("surfaces token-endpoint failures and never caches them", async () => {
		const fetchSpy = stubFetch(
			() => new Response("invalid_client", { status: 401 }),
		);
		const cacheKey = uniqueKey();

		const first = await resolveClientCredentialsToken(
			CRED,
			TOKEN_URL,
			"client_credentials",
			cacheKey,
			false,
		);
		expect(first).toEqual({
			token: null,
			error: "Token exchange failed (401): invalid_client",
		});

		await resolveClientCredentialsToken(
			CRED,
			TOKEN_URL,
			"client_credentials",
			cacheKey,
			false,
		);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});
});

// Each personal lookup must recheck run state, expiry and audit before transport.
describe("request-bound personal credential routing", () => {
	it("forwards signed child provenance and revalidates on every call", async () => {
		const { fetchTediConnectionToken } =
			await import("./handler-connection-credentials");
		const apiFetch = vi.fn(async (request: Request) => {
			expect(request.headers.get("X-Tedix-Request-Run-Id")).toBe("child");
			expect(request.headers.get("X-Tedix-Request-Root-Run-Id")).toBe("home");
			expect(request.headers.get("X-Tedix-Request-Work-Item-Id")).toBe("work");
			expect(request.headers.get("X-Tedix-Tedi-Id")).toBe("ceo");
			const body = (await request.json()) as { json: Record<string, unknown> };
			expect(body.json.delegatedToolUse).toEqual({
				appId: "gmail-app",
				arguments: { query: "week" },
			});
			return apiFetch.mock.calls.length === 1
				? Response.json({ json: { accessToken: "first" } })
				: Response.json({ json: { message: "run ended" } }, { status: 403 });
		});
		const ctx = {
			appId: "gmail-app",
			toolId: "search_threads",
			requestId: "req",
			config: {},
			env: { API_SERVICE: { fetch: apiFetch }, ENVIRONMENT: "test" },
			callerIdentity: {
				authType: "tedi",
				tediId: "ceo",
				organizationId: "org",
				scopes: ["connections.read"],
				requestRunId: "child",
				requestRootRunId: "home",
				requestWorkItemId: "work",
			},
			requestMeta: { "io.tedix/kernelRunId": "forged-other-run" },
		} as unknown as import("./handler").ToolExecutionContext<
			import("@tedix/api-contract/schemas/tools").ToolConfig
		>;
		expect(
			await fetchTediConnectionToken(
				ctx,
				"ceo",
				"google-gmail",
				"user",
				[],
				undefined,
				undefined,
				{ query: "week" },
			),
		).toMatchObject({ token: "first" });
		expect(
			await fetchTediConnectionToken(
				ctx,
				"ceo",
				"google-gmail",
				"user",
				[],
				undefined,
				undefined,
				{ query: "week" },
			),
		).toMatchObject({ token: null, status: 403 });
		expect(apiFetch).toHaveBeenCalledTimes(2);
	});
});
