import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileGatewayCooldown } from "./gateway-cooldown";
import { describe, expect, test } from "bun:test";
import {
	McpToolError,
	preDispatchUnavailableToolResult,
	unwrapCallToolResult,
} from "@tedix/mcp-shared/tool-result";
import {
	resendPreDispatchToolRefusals,
	retryRateLimitedPosts,
} from "./gateway-retry";

const limited = (retryAfter?: string) =>
	new Response(
		JSON.stringify({ error: "Rate limit exceeded", retryAfter: 60 }),
		{
			status: 429,
			headers: retryAfter === undefined ? {} : { "Retry-After": retryAfter },
		},
	);

const unavailable = (error: string, retryAfter?: string) =>
	Response.json(
		{ error, message: "Retry shortly." },
		{
			status: 503,
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

	test("resends a POST refused before dispatch because access could not be checked", async () => {
		for (const error of [
			"human_mcp_grant_unavailable",
			"external_agent_validation_unavailable",
		]) {
			const { wrapped, sent, waits } = harness([
				unavailable(error, "5"),
				unavailable(error, "5"),
				unavailable(error, "5"),
			]);
			const response = await wrapped("https://gateway.example/mcp", post);
			// Bounded: two resends, each waiting Retry-After plus up to as much again.
			expect(response.status).toBe(503);
			expect(sent).toHaveLength(3);
			expect(sent[2]!.body).toBe(post.body);
			expect(waits).toEqual([7_500, 7_500]);
		}
		const { wrapped, sent } = harness([
			unavailable("human_mcp_grant_unavailable", "5"),
		]);
		expect((await wrapped("https://gateway.example/mcp", post)).status).toBe(
			200,
		);
		expect(sent).toHaveLength(2);
	});

	test("does not resend other 503s or a 503 without a usable Retry-After", async () => {
		for (const response of [
			unavailable("tool_backend_unavailable", "5"),
			unavailable("human_mcp_grant_unavailable"),
			new Response("unavailable", {
				status: 503,
				headers: { "Retry-After": "5" },
			}),
		]) {
			const { wrapped, sent } = harness([response]);
			expect((await wrapped("https://gateway.example/mcp", post)).status).toBe(
				503,
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

describe.each([
	["autonomous_policy_unavailable", "Autonomous action policy is unavailable"],
	["attempt_authorization_unavailable", "Attempt authorization is unavailable"],
])("resendPreDispatchToolRefusals: %s", (code, message) => {
	const refusal = () =>
		unwrapCallToolResult(
			preDispatchUnavailableToolResult(
				code,
				`${message}; no side effect was executed.`,
				5,
			),
			"work.start",
		);
	const deps = (waits: number[]) => ({
		sleep: async (ms: number) => {
			waits.push(ms);
		},
		random: () => 0.5,
		now: () => 0,
	});

	test("resends a typed pre-dispatch refusal after Retry-After plus jitter", async () => {
		const waits: number[] = [];
		let calls = 0;
		const result = await resendPreDispatchToolRefusals(async () => {
			if (++calls === 1) refusal();
			return "ran once";
		}, deps(waits));
		expect(result).toBe("ran once");
		expect(calls).toBe(2);
		expect(waits).toEqual([7_500]);
	});

	test("gives up after two resends with the original error", async () => {
		const waits: number[] = [];
		let calls = 0;
		await expect(
			resendPreDispatchToolRefusals(async () => {
				calls++;
				return refusal();
			}, deps(waits)),
		).rejects.toThrow(message);
		expect(calls).toBe(3);
		expect(waits).toHaveLength(2);
	});

	test("never resends an untyped tool error or one that may have run", async () => {
		for (const error of [
			new McpToolError(message, undefined),
			new McpToolError("busy", {
				code,
				details: { retryAfterSeconds: 5 },
			}),
			new McpToolError("busy", {
				code,
				details: { executed: true, retryAfterSeconds: 5 },
			}),
			new McpToolError("busy", {
				code: "some_other_failure",
				details: { executed: false, retryAfterSeconds: 5 },
			}),
		]) {
			let calls = 0;
			await expect(
				resendPreDispatchToolRefusals(async () => {
					calls++;
					throw error;
				}, deps([])),
			).rejects.toBe(error);
			expect(calls).toBe(1);
		}
	});

	test("does not wait past the caller's deadline", async () => {
		const waits: number[] = [];
		let calls = 0;
		await expect(
			resendPreDispatchToolRefusals(
				async () => {
					calls++;
					return refusal();
				},
				{ ...deps(waits), deadlineAt: 7_000 },
			),
		).rejects.toThrow(message);
		expect(calls).toBe(1);
		expect(waits).toEqual([]);
	});
});
