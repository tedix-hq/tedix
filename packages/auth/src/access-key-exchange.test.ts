import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { DescopeAccessKeyExchange, parseJwtExp } from "./access-key-exchange";

function fakeJwt(exp: number): string {
	return [
		"eyJhbGciOiJub25lIn0",
		btoa(JSON.stringify({ exp })).replace(/=/g, ""),
		"signature",
	].join(".");
}

function fakeBase64UrlJwt(exp: number): string {
	const payload = btoa(JSON.stringify({ exp, marker: "ÿÿ" }))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=/g, "");
	return ["eyJhbGciOiJub25lIn0", payload, "signature"].join(".");
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("DescopeAccessKeyExchange", () => {
	it("reads expiry from an unpadded base64url JWT", () => {
		const exp = 1_900_000_000;
		expect(parseJwtExp(fakeBase64UrlJwt(exp))).toBe(exp);
	});
	it("exchanges an access key once and caches the session JWT", async () => {
		const jwt = fakeJwt(Math.floor(Date.now() / 1000) + 900);
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) => {
				return new Response(JSON.stringify({ sessionJwt: jwt }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			},
		);

		const auth = new DescopeAccessKeyExchange({
			descopeAccessKey: "ak_test",
			descopeProjectId: "P123",
			fetch: fetchMock as unknown as typeof fetch,
		});

		await expect(auth.getAuthHeader()).resolves.toBe(`Bearer ${jwt}`);
		await expect(auth.getAuthHeader()).resolves.toBe(`Bearer ${jwt}`);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const calls = fetchMock.mock.calls as unknown as Array<
			[RequestInfo | URL, RequestInit?]
		>;
		expect(calls[0]?.[0]).toBe(
			"https://auth.tedix.dev/v1/auth/accesskey/exchange",
		);
	});

	it("aborts a stalled exchange at its timeout without retrying", async () => {
		const fetchMock = vi.fn(
			(_input: RequestInfo | URL, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () =>
						reject(new DOMException("aborted", "AbortError")),
					);
				}),
		);
		const auth = new DescopeAccessKeyExchange({
			descopeAccessKey: "ak_test",
			descopeProjectId: "P123",
			timeoutMs: 5,
			fetch: fetchMock as unknown as typeof fetch,
		});

		await expect(auth.getToken()).rejects.toThrow("aborted");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("surfaces a provider 503 once instead of replaying the exchange", async () => {
		const fetchMock = vi.fn(
			async () => new Response("unavailable", { status: 503 }),
		);
		const auth = new DescopeAccessKeyExchange({
			descopeAccessKey: "ak_test",
			descopeProjectId: "P123",
			fetch: fetchMock as unknown as typeof fetch,
		});

		await expect(auth.getToken()).rejects.toThrow("(503)");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("parses JWT exp defensively", () => {
		const exp = 1_800_000_000;
		expect(parseJwtExp(fakeJwt(exp))).toBe(exp);
		expect(parseJwtExp("not-a-jwt")).toBe(0);
	});
});
