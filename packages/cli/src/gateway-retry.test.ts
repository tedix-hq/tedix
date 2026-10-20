import { describe, expect, test } from "bun:test";
import { retryRateLimitedPosts } from "./gateway-retry";

const limited = (retryAfter?: string) =>
	new Response(
		JSON.stringify({ error: "Rate limit exceeded", retryAfter: 60 }),
		{
			status: 429,
			headers: retryAfter === undefined ? {} : { "Retry-After": retryAfter },
		},
	);

function harness(responses: Response[]) {
	const sent: RequestInit[] = [];
	const waits: number[] = [];
	const fetchFn = async (_input: unknown, init?: RequestInit) => {
		sent.push(init ?? {});
		return responses.shift() ?? new Response("{}", { status: 200 });
	};
	const wrapped = retryRateLimitedPosts(fetchFn as typeof fetch, {
		sleep: async (ms, signal) => {
			signal?.throwIfAborted();
			waits.push(ms);
		},
		random: () => 0.5,
	});
	return { wrapped, sent, waits };
}

const post = { method: "POST", body: '{"jsonrpc":"2.0"}' };

describe("retryRateLimitedPosts", () => {
	test("resends a refused POST after Retry-After plus jitter", async () => {
		const { wrapped, sent, waits } = harness([limited("60")]);
		const response = await wrapped("https://gateway.example/mcp", post);
		expect(response.status).toBe(200);
		expect(sent).toHaveLength(2);
		expect(sent[1]!.body).toBe(post.body);
		expect(waits).toEqual([67_500]);
	});

	test("stops after two resends and returns the last refusal", async () => {
		const { wrapped, sent, waits } = harness([
			limited("2"),
			limited("2"),
			limited("2"),
		]);
		const response = await wrapped("https://gateway.example/mcp", post);
		expect(response.status).toBe(429);
		expect(sent).toHaveLength(3);
		expect(waits).toEqual([2_250, 2_250]);
	});

	test("does not resend without a usable Retry-After", async () => {
		for (const header of [undefined, "Wed, 21 Oct 2026 07:28:00 GMT", "600"]) {
			const { wrapped, sent } = harness([limited(header)]);
			expect((await wrapped("https://gateway.example/mcp", post)).status).toBe(
				429,
			);
			expect(sent).toHaveLength(1);
		}
	});

	test("does not resend streams or other methods", async () => {
		const { wrapped, sent } = harness([limited("1")]);
		const response = await wrapped("https://gateway.example/mcp", {
			method: "GET",
		});
		expect(response.status).toBe(429);
		expect(sent).toHaveLength(1);
	});

	test("never resends after the caller aborts", async () => {
		const controller = new AbortController();
		controller.abort(new Error("deadline"));
		const { wrapped, sent } = harness([limited("1")]);
		await expect(
			wrapped("https://gateway.example/mcp", {
				...post,
				signal: controller.signal,
			}),
		).rejects.toThrow("deadline");
		expect(sent).toHaveLength(1);
	});
});
