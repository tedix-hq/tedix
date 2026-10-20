import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { checkRateLimit, mcpRateLimitKey } from "./rate-limit";

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

describe("mcpRateLimitKey", () => {
	const key = (headers: Record<string, string>, ip = "203.0.113.7") =>
		mcpRateLimitKey("app-1", new Headers(headers), ip);

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
});
