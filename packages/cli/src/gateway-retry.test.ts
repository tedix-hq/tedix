import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileGatewayCooldown } from "./gateway-cooldown";
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
		cooldown: null,
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

test("a sibling process waits on a refusal marker before sending its first request", async () => {
	const configDir = mkdtempSync(join(tmpdir(), "gateway-cooldown-test-"));
	try {
		let now = 1000;
		let release!: () => void;
		const waiting = new Promise<void>((resolve) => {
			release = resolve;
		});
		let started!: () => void;
		const published = new Promise<void>((resolve) => {
			started = resolve;
		});
		let refused = false;
		const first = retryRateLimitedPosts(
			async () => {
				if (!refused) {
					refused = true;
					return limited("60");
				}
				return new Response("{}");
			},
			{
				cooldown: fileGatewayCooldown({ configDir }),
				now: () => now,
				random: () => 0,
				sleep: () => {
					started();
					return waiting;
				},
			},
		);
		const original = first("https://gateway.example/mcp", post);
		await published;
		let calls = 0;
		const waits: number[] = [];
		const sibling = retryRateLimitedPosts(
			async () => {
				calls++;
				return new Response("{}");
			},
			{
				cooldown: fileGatewayCooldown({ configDir }),
				now: () => now,
				random: () => 0.5,
				sleep: async (ms) => {
					expect(calls).toBe(0);
					waits.push(ms);
					now += ms;
				},
			},
		);
		await sibling("https://gateway.example/other-route", post);
		expect(waits).toEqual([67_500]);
		expect(calls).toBe(1);
		release();
		await original;
	} finally {
		rmSync(configDir, { recursive: true, force: true });
	}
});

test("cooldown extensions never shorten a sibling marker, and unrelated gateways stay independent", async () => {
	const configDir = mkdtempSync(join(tmpdir(), "gateway-cooldown-test-"));
	try {
		const a = fileGatewayCooldown({ configDir });
		const b = fileGatewayCooldown({ configDir });
		a.extend("https://one.example/mcp", 61_000);
		b.extend("https://one.example/mcp", 11_000);
		expect(a.read("https://one.example/mcp")).toBe(61_000);
		expect(b.read("https://two.example/mcp")).toBe(0);
		const controller = new AbortController();
		let sent = 0;
		const call = retryRateLimitedPosts(
			async () => {
				sent++;
				return new Response("{}");
			},
			{
				cooldown: b,
				now: () => 1000,
				sleep: async () => {
					controller.abort(new Error("deadline"));
				},
			},
		);
		await expect(
			call("https://one.example/mcp", { ...post, signal: controller.signal }),
		).rejects.toThrow("deadline");
		expect(sent).toBe(0);
	} finally {
		rmSync(configDir, { recursive: true, force: true });
	}
});
