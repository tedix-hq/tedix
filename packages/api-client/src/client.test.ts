import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { withRequestTimeout } from "./client";

afterEach(() => {
	vi.useRealTimers();
});

describe("withRequestTimeout", () => {
	it("aborts a transport that exceeds its deadline", async () => {
		vi.useFakeTimers();
		const fetchImpl = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) =>
				await new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener(
						"abort",
						() => reject(init.signal?.reason),
						{ once: true },
					);
				}),
		);
		const request = withRequestTimeout(
			fetchImpl,
			500,
		)("https://api.tedix.dev/rpc/slow");
		const rejection = expect(request).rejects.toThrow(
			"API request timed out after 500ms",
		);
		await vi.advanceTimersByTimeAsync(500);

		await rejection;
	});

	it("preserves an earlier caller abort reason", async () => {
		const caller = new AbortController();
		caller.abort(new Error("caller stopped"));
		const fetchImpl = vi.fn(
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				if (init?.signal?.aborted) throw init.signal.reason;
				return Response.json({ ok: true });
			},
		);

		await expect(
			withRequestTimeout(fetchImpl, 10_000)(
				"https://api.tedix.dev/rpc/stopped",
				{ signal: caller.signal },
			),
		).rejects.toThrow("caller stopped");
	});
});
