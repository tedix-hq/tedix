import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	checkMcpRequestRateLimit,
	checkRateLimit,
	mcpRateLimitBuckets,
	type RateLimiter,
} from "./rate-limit";

afterEach(() => vi.restoreAllMocks());

describe("checkRateLimit logging", () => {
	it("keeps denied keys out of durable logs", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const key = "customer-private-rate-limit-key";
		const result = await checkRateLimit(
			{ limit: vi.fn().mockResolvedValue({ success: false }) },
			key,
		);

		expect(result).toEqual({ allowed: false, error: "Rate limit exceeded" });
		expect(warn).toHaveBeenCalledOnce();
		expect(warn.mock.calls[0]).toMatchObject([
			{
				component: "mcp.rate_limit",
				event: "rate_limit.denied",
				outcome: "denied",
			},
		]);
		expect(JSON.stringify(warn.mock.calls)).not.toContain(key);
	});

	it("keeps fail-open behavior and records bounded cause chains", async () => {
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		const key = "customer-private-rate-limit-key";
		const result = await checkRateLimit(
			{
				limit: vi.fn().mockRejectedValue(
					new Error(`${key}: rate service unavailable`, {
						cause: new Error(`${key}: connection refused`),
					}),
				),
			},
			key,
		);

		expect(result).toEqual({ allowed: true });
		expect(errorLog).toHaveBeenCalledOnce();
		expect(errorLog.mock.calls[0]).toMatchObject([
			{
				component: "mcp.rate_limit",
				event: "rate_limit.unavailable",
				outcome: "unavailable",
				exception: {
					type: "Error",
					message: "[redacted rate-limit key]: rate service unavailable",
					cause: {
						type: "Error",
						message: "[redacted rate-limit key]: connection refused",
					},
				},
			},
		]);
		expect(JSON.stringify(errorLog.mock.calls)).not.toContain(key);
	});
});

describe("mcpRateLimitBuckets", () => {
	const key = (headers: Record<string, string>, ip = "203.0.113.7") =>
		mcpRateLimitBuckets("app-1", new Headers(headers), ip).request;

	it("gives each verified principal its own budget behind one address", () => {
		const owner = key({ "x-tedix-auth-user-id": "user-owner" });
		const lane = key({
			"x-tedix-auth-user-id": "user-owner",
			"x-tedix-auth-external-principal-id": "principal-lane",
		});
		const tedi = key({
			"x-tedix-auth-user-id": "client-record",
			"x-tedix-auth-tedi-id": "tedi-1",
		});

		expect(owner).toBe("app-1:user:user-owner");
		expect(lane).toBe("app-1:agent:principal-lane");
		expect(tedi).toBe("app-1:tedi:tedi-1");
		expect(new Set([owner, lane, tedi]).size).toBe(3);
	});

	it("keeps one principal on one budget across addresses", () => {
		const headers = { "x-tedix-auth-user-id": "user-owner" };
		expect(key(headers, "198.51.100.1")).toBe(key(headers, "198.51.100.2"));
	});

	it("falls back to the client address for anonymous callers", () => {
		expect(key({})).toBe("app-1:ip:203.0.113.7");
		expect(key({ "x-tedix-auth-user-id": "  " })).toBe("app-1:ip:203.0.113.7");
	});

	it("keys a verified external-agent session under its principal ceiling", () => {
		expect(
			mcpRateLimitBuckets(
				"app-1",
				new Headers({
					"x-tedix-auth-type": "external_agent",
					"x-tedix-auth-external-principal-id": "principal-lane",
					"x-tedix-auth-external-session-id": "session-a",
				}),
				"203.0.113.7",
			),
		).toEqual({
			request: "app-1:agent:principal-lane:session:session-a",
			ceiling: "app-1:agent:principal-lane",
		});
	});

	it("ignores a session claim not bound to a verified external-agent credential", () => {
		expect(
			mcpRateLimitBuckets(
				"app-1",
				new Headers({
					"x-tedix-auth-type": "oauth",
					"x-tedix-auth-external-principal-id": "principal-lane",
					"x-tedix-auth-external-session-id": "session-a",
				}),
				"203.0.113.7",
			),
		).toEqual({ request: "app-1:agent:principal-lane" });
		expect(
			mcpRateLimitBuckets(
				"app-1",
				new Headers({
					"x-tedix-auth-type": "external_agent",
					"x-tedix-auth-user-id": "user-owner",
					"x-tedix-auth-external-session-id": "session-a",
				}),
				"203.0.113.7",
			),
		).toEqual({ request: "app-1:user:user-owner" });
	});
});

/** A fixed-window limiter that admits `limit` calls per key. */
function countingLimiter(limit: number) {
	const counts = new Map<string, number>();
	const limiter: RateLimiter = {
		limit: async ({ key }) => {
			const next = (counts.get(key) ?? 0) + 1;
			counts.set(key, next);
			return { success: next <= limit };
		},
	};
	return { limiter, counts };
}

describe("checkMcpRequestRateLimit", () => {
	const sessionHeaders = (session: string) =>
		new Headers({
			"x-tedix-auth-type": "external_agent",
			"x-tedix-auth-external-principal-id": "principal-lane",
			"x-tedix-auth-external-session-id": session,
		});
	const admitted = async (
		env: Parameters<typeof checkMcpRequestRateLimit>[0],
		headers: Headers,
		times: number,
	) => {
		let allowed = 0;
		for (let i = 0; i < times; i += 1) {
			const result = await checkMcpRequestRateLimit(
				env,
				"app-1",
				headers,
				"203.0.113.7",
			);
			if (result.allowed) allowed += 1;
		}
		return allowed;
	};

	it("keeps two sessions of one principal from starving each other", async () => {
		const env = {
			MCP_RATE_LIMITER: countingLimiter(3).limiter,
			MCP_PRINCIPAL_RATE_LIMITER: countingLimiter(10).limiter,
		};

		expect(await admitted(env, sessionHeaders("session-a"), 5)).toBe(3);
		expect(await admitted(env, sessionHeaders("session-b"), 3)).toBe(3);
	});

	it("still trips the principal ceiling across sessions", async () => {
		const principal = countingLimiter(4);
		const env = {
			MCP_RATE_LIMITER: countingLimiter(3).limiter,
			MCP_PRINCIPAL_RATE_LIMITER: principal.limiter,
		};

		expect(await admitted(env, sessionHeaders("session-a"), 3)).toBe(3);
		expect(await admitted(env, sessionHeaders("session-b"), 3)).toBe(1);
		expect(await admitted(env, sessionHeaders("session-c"), 1)).toBe(0);
		expect([...principal.counts.keys()]).toEqual([
			"app-1:agent:principal-lane",
		]);
	});

	it("does not charge the ceiling for a request its session bucket refused", async () => {
		const principal = countingLimiter(100);
		const env = {
			MCP_RATE_LIMITER: countingLimiter(1).limiter,
			MCP_PRINCIPAL_RATE_LIMITER: principal.limiter,
		};

		expect(await admitted(env, sessionHeaders("session-a"), 3)).toBe(1);
		expect(principal.counts.get("app-1:agent:principal-lane")).toBe(1);
	});

	it("charges sessions to the principal key until the ceiling is bound", async () => {
		const request = countingLimiter(3);
		const env = { MCP_RATE_LIMITER: request.limiter };

		expect(await admitted(env, sessionHeaders("session-a"), 2)).toBe(2);
		expect(await admitted(env, sessionHeaders("session-b"), 2)).toBe(1);
		expect([...request.counts.keys()]).toEqual(["app-1:agent:principal-lane"]);
	});

	it("keys an unverified session claim by principal only", async () => {
		const request = countingLimiter(2);
		const principal = countingLimiter(100);
		const env = {
			MCP_RATE_LIMITER: request.limiter,
			MCP_PRINCIPAL_RATE_LIMITER: principal.limiter,
		};
		const claim = (session: string) =>
			new Headers({
				"x-tedix-auth-type": "oauth",
				"x-tedix-auth-external-principal-id": "principal-lane",
				"x-tedix-auth-external-session-id": session,
			});

		expect(await admitted(env, claim("session-a"), 2)).toBe(2);
		expect(await admitted(env, claim("session-b"), 2)).toBe(0);
		expect(principal.counts.size).toBe(0);
	});

	it("keeps owner requests on the user key with no ceiling", async () => {
		const request = countingLimiter(2);
		const principal = countingLimiter(100);
		const env = {
			MCP_RATE_LIMITER: request.limiter,
			MCP_PRINCIPAL_RATE_LIMITER: principal.limiter,
		};
		const owner = new Headers({ "x-tedix-auth-user-id": "user-owner" });

		expect(await admitted(env, owner, 3)).toBe(2);
		expect([...request.counts.keys()]).toEqual(["app-1:user:user-owner"]);
		expect(principal.counts.size).toBe(0);
	});
});
