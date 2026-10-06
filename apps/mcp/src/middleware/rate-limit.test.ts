import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { checkRateLimit } from "./rate-limit";

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
