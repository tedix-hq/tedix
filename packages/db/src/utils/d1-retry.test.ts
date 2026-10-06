import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	D1ReadTimeoutError,
	isTransientD1ReadError,
	withTransientD1ReadRetry,
} from "./d1-retry";

describe("bounded D1 read recovery", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});
	it("retries a completed transient failure once without logging SQL or secrets", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const read = vi
			.fn()
			.mockRejectedValueOnce(
				new Error("query secret", {
					cause: new Error("D1_ERROR: Network connection lost secret"),
				}),
			)
			.mockResolvedValueOnce("ok");
		expect(
			await withTransientD1ReadRetry("identity", read, {
				delayMs: 0,
				timeoutMs: 100,
			}),
		).toBe("ok");
		expect(read).toHaveBeenCalledTimes(2);
		expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
	});
	it("bounds an unresolved read and never overlaps it with a retry", async () => {
		vi.useFakeTimers();
		vi.spyOn(console, "error").mockImplementation(() => {});
		let finish!: (value: string) => void;
		const read = vi.fn(
			() =>
				new Promise<string>((resolve) => {
					finish = resolve;
				}),
		);
		const result = withTransientD1ReadRetry("identity", read, {
			timeoutMs: 100,
		});
		const assertion = expect(result).rejects.toBeInstanceOf(D1ReadTimeoutError);
		await vi.advanceTimersByTimeAsync(100);
		await assertion;
		finish("late");
		await vi.runAllTimersAsync();
		expect(read).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});
	it("does not retry nontransient failures and handles cyclic causes", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const error = new Error("constraint failed");
		error.cause = error;
		expect(isTransientD1ReadError(error)).toBe(false);
		const read = vi.fn().mockRejectedValue(error);
		await expect(withTransientD1ReadRetry("identity", read)).rejects.toBe(
			error,
		);
		expect(read).toHaveBeenCalledTimes(1);
	});
	it("uses one deadline across attempts", async () => {
		vi.useFakeTimers();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const read = vi
			.fn()
			.mockRejectedValueOnce(new Error("D1_ERROR: Network connection lost"))
			.mockImplementationOnce(() => new Promise(() => {}));
		const result = withTransientD1ReadRetry("identity", read, {
			timeoutMs: 100,
			delayMs: 20,
		});
		const assertion = expect(result).rejects.toBeInstanceOf(D1ReadTimeoutError);
		await vi.advanceTimersByTimeAsync(100);
		await assertion;
		expect(read).toHaveBeenCalledTimes(2);
		expect(vi.getTimerCount()).toBe(0);
	});
});
