import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { descopeFetch, descopeManagementFetch } from "./descope-fetch";

const TEST_URL = "https://identity.example.com/v1/test";
const AUTH = {
	DESCOPE_PROJECT_ID: "P3fictional",
	DESCOPE_MANAGEMENT_KEY: "fictional-key",
};

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("descopeFetch idempotent calls", () => {
	it("retries a network error then succeeds", async () => {
		vi.useFakeTimers();
		const fetchMock = vi
			.fn()
			.mockRejectedValueOnce(new TypeError("fetch failed"))
			.mockResolvedValueOnce(new Response("{}"));
		const pending = descopeFetch(
			TEST_URL,
			{ method: "GET" },
			{ idempotent: true, fetch: fetchMock as unknown as typeof fetch },
		);
		await vi.runAllTimersAsync();
		expect((await pending).status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("retries a per-attempt timeout then succeeds", async () => {
		vi.useFakeTimers();
		const fetchMock = vi
			.fn()
			.mockImplementationOnce(
				(_input: RequestInfo | URL, init?: RequestInit) =>
					new Promise<Response>((_resolve, reject) =>
						init?.signal?.addEventListener("abort", () =>
							reject(new DOMException("aborted", "AbortError")),
						),
					),
			)
			.mockResolvedValueOnce(new Response("{}"));
		const pending = descopeFetch(
			TEST_URL,
			{ method: "GET" },
			{
				idempotent: true,
				timeoutMs: 50,
				fetch: fetchMock as unknown as typeof fetch,
			},
		);
		await vi.runAllTimersAsync();
		expect((await pending).status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("retries a 503 then succeeds", async () => {
		vi.useFakeTimers();
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
			.mockResolvedValueOnce(new Response("{}"));
		const pending = descopeFetch(
			TEST_URL,
			{ method: "GET" },
			{ idempotent: true, fetch: fetchMock as unknown as typeof fetch },
		);
		await vi.runAllTimersAsync();
		expect((await pending).status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("returns the final non-ok response instead of throwing", async () => {
		vi.useFakeTimers();
		// A fresh Response per attempt: descopeFetch drains intermediate bodies.
		const fetchMock = vi
			.fn()
			.mockImplementation(() =>
				Promise.resolve(new Response("down", { status: 503 })),
			);
		const pending = descopeFetch(
			TEST_URL,
			{ method: "GET" },
			{ idempotent: true, fetch: fetchMock as unknown as typeof fetch },
		);
		await vi.runAllTimersAsync();
		const response = await pending;
		expect(response.status).toBe(503);
		expect(await response.text()).toBe("down");
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("throws the last network error when every attempt fails", async () => {
		vi.useFakeTimers();
		const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
		const pending = descopeFetch(
			TEST_URL,
			{ method: "GET" },
			{ idempotent: true, fetch: fetchMock as unknown as typeof fetch },
		);
		const assertion = expect(pending).rejects.toThrow("fetch failed");
		await vi.runAllTimersAsync();
		await assertion;
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});
});

describe("descopeFetch mutations", () => {
	it("throws a network error once without retrying", async () => {
		const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
		await expect(
			descopeFetch(
				TEST_URL,
				{ method: "POST" },
				{ fetch: fetchMock as unknown as typeof fetch },
			),
		).rejects.toThrow("fetch failed");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("returns a 500 immediately without retrying", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response("oops", { status: 500 }));
		const response = await descopeFetch(
			TEST_URL,
			{ method: "POST" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		expect(response.status).toBe(500);
		expect(await response.text()).toBe("oops");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("retries a 429 after a Retry-After seconds delay", async () => {
		vi.useFakeTimers();
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response("{}", { status: 429, headers: { "Retry-After": "2" } }),
			)
			.mockResolvedValueOnce(new Response("{}"));
		const pending = descopeFetch(
			TEST_URL,
			{ method: "POST" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		await vi.advanceTimersByTimeAsync(1999);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect((await pending).status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("honours an HTTP-date Retry-After", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response("{}", {
					status: 429,
					headers: { "Retry-After": "Fri, 16 Oct 2026 12:00:03 GMT" },
				}),
			)
			.mockResolvedValueOnce(new Response("{}"));
		const pending = descopeFetch(
			TEST_URL,
			{ method: "POST" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		await vi.advanceTimersByTimeAsync(2999);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect((await pending).status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("returns a 429 whose Retry-After exceeds the retry budget", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				new Response("{}", { status: 429, headers: { "Retry-After": "60" } }),
			);
		const response = await descopeFetch(
			TEST_URL,
			{ method: "POST" },
			{ fetch: fetchMock as unknown as typeof fetch },
		);
		expect(response.status).toBe(429);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("returns a 429 on the last attempt without waiting", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response("{}", { status: 429 }));
		const response = await descopeFetch(
			TEST_URL,
			{ method: "POST" },
			{ retries: 0, fetch: fetchMock as unknown as typeof fetch },
		);
		expect(response.status).toBe(429);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe("descopeFetch timing", () => {
	it("aborts a stalled attempt after timeoutMs and fires the passed signal", async () => {
		vi.useFakeTimers();
		let passedSignal: AbortSignal | undefined;
		const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
			passedSignal = init?.signal ?? undefined;
			return new Promise<Response>((_resolve, reject) =>
				init?.signal?.addEventListener("abort", () =>
					reject(new DOMException("aborted", "AbortError")),
				),
			);
		});
		const pending = descopeFetch(
			TEST_URL,
			{ method: "POST" },
			{ timeoutMs: 100, fetch: fetchMock as unknown as typeof fetch },
		);
		const assertion = expect(pending).rejects.toThrow("aborted");
		await vi.advanceTimersByTimeAsync(99);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(passedSignal?.aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await assertion;
		expect(passedSignal?.aborted).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("bounds the jittered backoff under 2,125 ms", async () => {
		vi.useFakeTimers();
		// Worst-case jitter: floor(0.9999 * 125) = 124 ms on top of the capped
		// 2,000 ms base → the largest legal sleep is 2,124 ms.
		vi.spyOn(Math, "random").mockReturnValue(0.9999);
		const fetchMock = vi
			.fn()
			.mockImplementation(() =>
				Promise.resolve(new Response("{}", { status: 503 })),
			);
		const pending = descopeFetch(
			TEST_URL,
			{ method: "GET" },
			{
				idempotent: true,
				retries: 5,
				fetch: fetchMock as unknown as typeof fetch,
			},
		);
		// Sleeps after attempts 0-3: 374 + 624 + 1124 + 2124 ms → call 5 at t=4246.
		await vi.advanceTimersByTimeAsync(4246);
		expect(fetchMock).toHaveBeenCalledTimes(5);
		// Attempt 4's uncapped base would be 4,000 ms; capped it is 2,124 ms.
		await vi.advanceTimersByTimeAsync(2123);
		expect(fetchMock).toHaveBeenCalledTimes(5);
		await vi.advanceTimersByTimeAsync(1);
		expect((await pending).status).toBe(503);
		expect(fetchMock).toHaveBeenCalledTimes(6);
	});
});

describe("descopeManagementFetch", () => {
	it("sends the bearer header and JSON body", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("{}"));
		const response = await descopeManagementFetch(AUTH, {
			url: TEST_URL,
			method: "POST",
			body: { hello: "world" },
			idempotent: false,
			errorPrefix: "mgmt",
		});
		expect(response.ok).toBe(true);
		const init = fetchMock.mock.calls[0]?.[1];
		expect(init?.headers).toEqual({
			Authorization: "Bearer P3fictional:fictional-key",
			"Content-Type": "application/json",
		});
		expect(init?.body).toBe(JSON.stringify({ hello: "world" }));
	});

	it("throws `${errorPrefix} [status statusText]: body` on a non-ok status", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("tenant conflict", {
				status: 409,
				statusText: "Conflict",
			}),
		);
		await expect(
			descopeManagementFetch(AUTH, {
				url: TEST_URL,
				method: "POST",
				idempotent: false,
				errorPrefix: "create tenant",
			}),
		).rejects.toThrow("create tenant [409 Conflict]: tenant conflict");
	});

	it("passes idempotent retry-safety through to descopeFetch", async () => {
		vi.useFakeTimers();
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response("down", { status: 503 }))
			.mockResolvedValueOnce(new Response("{}"));
		const pending = descopeManagementFetch(AUTH, {
			url: TEST_URL,
			method: "GET",
			idempotent: true,
			errorPrefix: "read",
		});
		await vi.runAllTimersAsync();
		expect((await pending).status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("does not retry a mutation on 5xx", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("down", { status: 503 }));
		await expect(
			descopeManagementFetch(AUTH, {
				url: TEST_URL,
				method: "POST",
				idempotent: false,
				errorPrefix: "write",
			}),
		).rejects.toThrow("write [503");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
