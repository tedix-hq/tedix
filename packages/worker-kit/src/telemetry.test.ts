import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createTelemetryWriter, runWithTelemetrySpan } from "./telemetry";

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("optional telemetry writes", () => {
	it.each(["before", "after", "attributes", "pending"])(
		"runs the operation once when tracing fails %s",
		async (failure) => {
			vi.spyOn(console, "warn").mockImplementation(() => {});
			const run = vi.fn(async (span) => {
				span.setAttribute("outcome", "success");
				return { ok: true };
			});
			const enter = (
				callback: (span: { setAttribute: () => void }) => Promise<unknown>,
			) => {
				if (failure === "before") throw new Error("trace unavailable");
				const result = callback({
					setAttribute: () => {
						if (failure === "attributes") throw new Error("trace full");
					},
				});
				if (failure === "pending") return new Promise(() => {});
				return result.then(() => {
					throw new Error("trace export failed");
				});
			};
			await expect(runWithTelemetrySpan(enter, run)).resolves.toEqual({
				ok: true,
			});
			expect(run).toHaveBeenCalledTimes(1);
		},
	);

	it("does not repeat the operation when a tracer dispatches late", async () => {
		let late!: (span: { setAttribute: () => void }) => Promise<unknown>;
		const run = vi.fn(async () => "ok");
		await expect(
			runWithTelemetrySpan((callback) => {
				late = callback;
			}, run),
		).resolves.toBe("ok");
		await expect(late({ setAttribute: () => {} })).resolves.toBe("ok");
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("preserves a failed operation when the tracer also fails", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const failure = new Error("business failure");
		const run = vi.fn(async () => {
			throw failure;
		});
		await expect(
			runWithTelemetrySpan(() => {
				throw new Error("trace unavailable");
			}, run),
		).rejects.toBe(failure);
		expect(run).toHaveBeenCalledTimes(1);
	});
	it("contains synchronous throws and rejected promises", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const write = createTelemetryWriter("test.telemetry");
		const pending: Promise<unknown>[] = [];
		expect(() =>
			write(() => {
				throw new Error("private payload");
			}),
		).not.toThrow();
		write(
			() => Promise.reject(new Error("private payload")),
			(p) => pending.push(p),
		);
		await expect(Promise.all(pending)).resolves.toEqual([undefined]);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(warn.mock.calls)).not.toContain("private payload");
	});

	it("does not await an asynchronous writer", async () => {
		const write = createTelemetryWriter("test.telemetry");
		const pending: Promise<unknown>[] = [];
		let finish!: () => void;
		const result = write(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
			(p) => pending.push(p),
		);
		expect(result).toBeUndefined();
		expect(pending).toHaveLength(1);
		finish();
		await Promise.all(pending);
	});

	it("bounds failure logs to one per minute without dropping writes", () => {
		vi.useFakeTimers();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const write = createTelemetryWriter("test.telemetry");
		const sink = vi.fn(() => {
			throw new Error("limit exceeded");
		});
		for (let i = 0; i < 100; i++) write(sink);
		expect(sink).toHaveBeenCalledTimes(100);
		expect(warn).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(60_000);
		write(sink);
		expect(warn).toHaveBeenCalledTimes(2);
	});

	it("does not report operation errors as telemetry failures", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(Date.now() + 60_001);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const failure = new Error("business failure");
		await expect(
			runWithTelemetrySpan(
				(callback) => callback({ setAttribute: () => {} }),
				async () => {
					throw failure;
				},
			),
		).rejects.toBe(failure);
		await Promise.resolve();
		expect(warn).not.toHaveBeenCalled();
	});

	it.each(["throw", "reject"])(
		"contains a throwing lifetime scheduler when diagnostics %s",
		async (failure) => {
			vi.spyOn(console, "warn").mockImplementation(() => {
				if (failure === "reject") return Promise.reject(new Error("logs full"));
				throw new Error("logs full");
			});
			const write = createTelemetryWriter("test.telemetry");
			const schedule = () => {
				throw new Error("context closed");
			};
			expect(() =>
				write(() => Promise.reject(new Error("limit exceeded")), schedule),
			).not.toThrow();
			await Promise.resolve();
			await Promise.resolve();
		},
	);
});
