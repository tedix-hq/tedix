import { describe, expect, it, vi } from "vite-plus/test";
import { withModelFallback } from "./model-fallback";
import { autoRouterSdkStream } from "./auto-router-stream";
import type { ModelFallbackPolicy } from "@tedix/api-contract/schemas/model-fallback";
const a = "azure-openai/gpt-6.1-sol",
	b = "azure-openai/gpt-6-luna";
const policy: ModelFallbackPolicy = {
	version: 1,
	maxTransitions: 1,
	ladder: { [a]: [b] },
};
function fixture(
	generate: () => Promise<unknown>,
	record = vi.fn(async (_step: unknown) => {}),
) {
	const second = vi.fn(async () => ({ text: "fallback" }));
	const load = vi.fn(async () => policy);
	const model = withModelFallback(
		{ provider: "test", modelId: a, doGenerate: generate, doStream: generate },
		{
			primaryRef: a,
			load,
			resolve: async () => ({
				provider: "test",
				modelId: b,
				doGenerate: second,
				doStream: second,
			}),
			record,
		},
	);
	return { model, second, load, record };
}
describe("governed model fallback", () => {
	it("does not load config or change primary success", async () => {
		const f = fixture(async () => ({ text: "primary" }));
		expect(await f.model.doGenerate()).toEqual({ text: "primary" });
		expect(f.load).not.toHaveBeenCalled();
	});
	it("records before dispatch and uses the next model for provider credits", async () => {
		const f = fixture(async () => {
			throw { statusCode: 402 };
		});
		await f.model.doGenerate();
		expect(f.record).toHaveBeenCalledWith({
			from: a,
			to: b,
			reason: "credits_exhausted",
			ordinal: 1,
			policyVersion: 1,
		});
		expect(f.record.mock.invocationCallOrder[0]).toBeLessThan(
			f.second.mock.invocationCallOrder[0]!,
		);
	});
	it("refuses dispatch when the receipt cannot be persisted", async () => {
		const f = fixture(
			async () => {
				throw { statusCode: 402 };
			},
			vi.fn(async () => {
				throw new Error("ledger unavailable");
			}),
		);
		await expect(f.model.doGenerate()).rejects.toThrow("ledger unavailable");
		expect(f.second).not.toHaveBeenCalled();
	});
	it("never switches on auth, rate limiting or cancellation", async () => {
		for (const error of [
			{ statusCode: 401 },
			{ statusCode: 429 },
			new DOMException("cancelled", "AbortError"),
		]) {
			const f = fixture(async () => {
				throw error;
			});
			await expect(f.model.doGenerate()).rejects.toBe(error);
			expect(f.load).not.toHaveBeenCalled();
		}
	});
	it("retries 5xx twice before switching", async () => {
		const primary = vi.fn(async () => {
			throw { statusCode: 503 };
		});
		const f = fixture(primary);
		await f.model.doGenerate();
		expect(primary).toHaveBeenCalledTimes(3);
		expect(f.second).toHaveBeenCalledTimes(1);
	});
	it("stays on the fallback for later calls instead of retrying the failed model", async () => {
		const primary = vi.fn(async () => {
			throw { statusCode: 503 };
		});
		const f = fixture(primary);
		await f.model.doGenerate();
		await f.model.doGenerate();
		expect(primary).toHaveBeenCalledTimes(3);
		expect(f.second).toHaveBeenCalledTimes(2);
		expect(f.record).toHaveBeenCalledTimes(1);
	});
	it("moves an Auto Router request rejection to the next model without retrying, and only for Auto", async () => {
		const auto = "cloudflare/auto";
		const primary = vi.fn(async () => {
			throw { statusCode: 400 };
		});
		const second = vi.fn(async () => ({ text: "fallback" }));
		const record = vi.fn(async (_step: unknown) => {});
		const model = withModelFallback(
			{ doGenerate: primary, doStream: primary },
			{
				primaryRef: auto,
				load: async () => ({
					version: 1,
					maxTransitions: 1,
					ladder: { [auto]: [b] },
				}),
				resolve: async () => ({ doGenerate: second, doStream: second }),
				record,
			},
		);
		expect(await model.doGenerate()).toEqual({ text: "fallback" });
		expect(primary).toHaveBeenCalledTimes(1);
		expect(record).toHaveBeenCalledWith(
			expect.objectContaining({ from: auto, to: b }),
		);

		const fixed = fixture(async () => {
			throw { statusCode: 400 };
		});
		await expect(fixed.model.doGenerate()).rejects.toEqual({ statusCode: 400 });
		expect(fixed.second).not.toHaveBeenCalled();
	});
});

describe("stream fallback boundaries", () => {
	it.each([
		{ choices: [{ delta: {} }] },
		{ choices: [{ delta: {}, finish_reason: "stop" }] },
		{ choices: [], usage: { prompt_tokens: 1, completion_tokens: 0 } },
	])(
		"moves an incomplete empty Auto stream down the governed ladder: %j",
		async (frame) => {
			const primary = vi.fn(async () => ({
				stream: autoRouterSdkStream(
					new ReadableStream({
						start(c) {
							c.enqueue(
								new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`),
							);
							c.close();
						},
					}),
					undefined,
				),
			}));
			const second = vi.fn(async () => ({
				stream: new ReadableStream({
					start(c) {
						c.enqueue({ type: "text-delta", delta: "judgment" });
						c.close();
					},
				}),
			}));
			const record = vi.fn(async (_step: unknown) => {});
			const model = withModelFallback(
				{ doStream: primary },
				{
					primaryRef: "cloudflare/auto",
					load: async () => ({
						version: 1,
						maxTransitions: 1,
						ladder: { "cloudflare/auto": [b] },
					}),
					resolve: () => ({ doStream: second }),
					record,
				},
			);
			const result = await model.doStream();
			expect((await result.stream.getReader().read()).value).toEqual({
				type: "text-delta",
				delta: "judgment",
			});
			expect(primary).toHaveBeenCalledTimes(1);
			expect(second).toHaveBeenCalledTimes(1);
			expect(record).toHaveBeenCalledWith({
				from: "cloudflare/auto",
				to: b,
				reason: "provider_unavailable",
				ordinal: 1,
				policyVersion: 1,
			});
			expect(record.mock.invocationCallOrder[0]).toBeLessThan(
				second.mock.invocationCallOrder[0]!,
			);
		},
	);
	it.each([
		{ content: "partial judgment" },
		{
			tool_calls: [
				{ index: 0, id: "call", function: { name: "save", arguments: "{}" } },
			],
		},
	])(
		"never replays an incomplete Auto stream after output: %j",
		async (delta) => {
			const first = {
				doStream: async () => ({
					stream: autoRouterSdkStream(
						new ReadableStream({
							start(c) {
								c.enqueue(
									new TextEncoder().encode(
										`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`,
									),
								);
								c.close();
							},
						}),
						undefined,
					),
				}),
			};
			const load = vi.fn(async () => policy);
			const model = withModelFallback(first, {
				primaryRef: "cloudflare/auto",
				load,
				resolve: () => first,
				record: async () => {},
			});
			const result = await model.doStream();
			await expect(
				(async () => {
					for await (const _part of result.stream) {
						/* consume until terminal error */
					}
				})(),
			).rejects.toThrow("Incomplete Auto Router stream");
			expect(load).not.toHaveBeenCalled();
		},
	);
	it("falls back for an error frame before output and cancels the failed reader", async () => {
		let cancelled = false;
		const first = {
			provider: "test",
			modelId: a,
			doStream: async () => ({
				stream: new ReadableStream({
					start(c) {
						c.enqueue({ type: "stream-start" });
						c.enqueue({ type: "error", error: { statusCode: 402 } });
					},
					cancel() {
						cancelled = true;
					},
				}),
			}),
		};
		const record = vi.fn(async () => {});
		const second = {
			...first,
			doStream: async () => ({
				stream: new ReadableStream({
					start(c) {
						c.enqueue({ type: "text-start", id: "text" });
						c.close();
					},
				}),
			}),
		};
		const model = withModelFallback(first, {
			primaryRef: a,
			load: async () => policy,
			resolve: () => second,
			record,
		});
		const result = await model.doStream();
		expect((await result.stream.getReader().read()).value.type).toBe(
			"text-start",
		);
		expect(cancelled).toBe(true);
		expect(record).toHaveBeenCalledTimes(1);
	});
	it("does not replay a failure after text starts", async () => {
		const first = {
			provider: "test",
			modelId: a,
			doStream: async () => ({
				stream: new ReadableStream({
					start(c) {
						c.enqueue({ type: "text-start", id: "text" });
						c.enqueue({ type: "error", error: { statusCode: 503 } });
						c.close();
					},
				}),
			}),
		};
		const load = vi.fn(async () => policy);
		const model = withModelFallback(first, {
			primaryRef: a,
			load,
			resolve: () => first,
			record: async () => {},
		});
		const result = await model.doStream();
		const reader = result.stream.getReader();
		expect((await reader.read()).value.type).toBe("text-start");
		expect((await reader.read()).value.type).toBe("error");
		expect(load).not.toHaveBeenCalled();
	});
});

describe("Tedix stream deadlines", () => {
	const limits = { firstOutputMs: 30, idleMs: 20, totalMs: 100 };
	function timed(
		primary: (options?: { abortSignal?: AbortSignal }) => Promise<unknown>,
		backup = primary,
		record = vi.fn(async (_step: unknown) => {}),
	) {
		const second = vi.fn(backup);
		const model = withModelFallback(
			{ doStream: vi.fn(primary) },
			{
				primaryRef: a,
				deadlines: limits,
				load: async () => ({ ...policy, maxTransitions: 5 }),
				resolve: () => ({ doStream: second }),
				record,
			},
		);
		return { model, second, record };
	}
	const silent = () => new Promise<never>(() => {});
	it("aborts a silent dispatch and records exactly one backup before it executes", async () => {
		vi.useFakeTimers();
		try {
			let primarySignal: AbortSignal | undefined;
			const f = timed(
				async (options) => {
					primarySignal = options?.abortSignal;
					return silent();
				},
				async () => ({
					stream: new ReadableStream({
						start(c) {
							c.enqueue({ type: "text-delta", delta: "backup" });
							c.close();
						},
					}),
				}),
			);
			const result = f.model.doStream({});
			await vi.advanceTimersByTimeAsync(30);
			const stream = ((await result) as { stream: ReadableStream }).stream;
			for await (const _part of stream) {
				/* consume */
			}
			expect(primarySignal?.aborted).toBe(true);
			expect(f.second).toHaveBeenCalledTimes(1);
			expect(f.record).toHaveBeenCalledTimes(1);
			expect(f.record.mock.invocationCallOrder[0]).toBeLessThan(
				f.second.mock.invocationCallOrder[0]!,
			);
		} finally {
			vi.useRealTimers();
		}
	});
	it("stops a second silent provider without a third dispatch", async () => {
		vi.useFakeTimers();
		try {
			const f = timed(silent);
			const rejected = expect(f.model.doStream()).rejects.toThrow(
				"first_output",
			);
			await vi.advanceTimersByTimeAsync(60);
			await rejected;
			expect(f.second).toHaveBeenCalledTimes(1);
			expect(f.record).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});
	it.each(["text-delta", "reasoning-delta", "tool-input-delta"])(
		"ends an idle %s stream visibly without replay",
		async (type) => {
			vi.useFakeTimers();
			try {
				const cancel = vi.fn();
				const f = timed(async () => ({
					stream: new ReadableStream({
						start(c) {
							c.enqueue({ type, delta: "started" });
						},
						cancel,
					}),
				}));
				const result = (await f.model.doStream()) as { stream: ReadableStream };
				const reader = result.stream.getReader();
				expect((await reader.read()).value).toEqual({ type, delta: "started" });
				const rejected = expect(reader.read()).rejects.toThrow("idle");
				await vi.advanceTimersByTimeAsync(20);
				await rejected;
				expect(f.second).not.toHaveBeenCalled();
				expect(f.record).not.toHaveBeenCalled();
				expect(cancel).toHaveBeenCalledTimes(1);
			} finally {
				vi.useRealTimers();
			}
		},
	);
	it("keeps transition recording inside the original absolute budget", async () => {
		vi.useFakeTimers();
		try {
			const f = timed(silent, silent, vi.fn(silent));
			const rejected = expect(f.model.doStream()).rejects.toThrow("total");
			await vi.advanceTimersByTimeAsync(100);
			await rejected;
			expect(f.record).toHaveBeenCalledTimes(1);
			expect(f.second).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});

it("does not treat text-start or an empty delta as first output", async () => {
	vi.useFakeTimers();
	try {
		const first = {
			doStream: async () => ({
				stream: new ReadableStream({
					start(c) {
						c.enqueue({ type: "text-start", id: "silent" });
						c.enqueue({ type: "text-delta", delta: "" });
					},
				}),
			}),
		};
		const second = vi.fn(async () => ({
			stream: new ReadableStream({
				start(c) {
					c.enqueue({ type: "text-delta", delta: "backup" });
					c.close();
				},
			}),
		}));
		const model = withModelFallback(first, {
			primaryRef: a,
			deadlines: { firstOutputMs: 30, idleMs: 20, totalMs: 100 },
			load: async () => policy,
			resolve: () => ({ doStream: second }),
			record: async () => {},
		});
		const pending = model.doStream();
		await vi.advanceTimersByTimeAsync(30);
		const reader = (await pending).stream.getReader();
		expect((await reader.read()).value).toEqual({
			type: "text-delta",
			delta: "backup",
		});
		await reader.read();
		expect(second).toHaveBeenCalledTimes(1);
	} finally {
		vi.useRealTimers();
	}
});

it("continuous reasoning progress cannot extend the absolute budget", async () => {
	vi.useFakeTimers();
	let emit!: () => void;
	try {
		const first = {
			doStream: async () => ({
				stream: new ReadableStream({
					start(c) {
						emit = () =>
							c.enqueue({ type: "reasoning-delta", delta: "thinking" });
						emit();
					},
				}),
			}),
		};
		const record = vi.fn(async () => {});
		const model = withModelFallback(first, {
			primaryRef: a,
			deadlines: { firstOutputMs: 30, idleMs: 20, totalMs: 100 },
			load: async () => policy,
			resolve: () => first,
			record,
		});
		const result = await model.doStream();
		const consumption = (async () => {
			for await (const _part of result.stream) {
				/* consume */
			}
		})();
		const rejected = expect(consumption).rejects.toThrow("total");
		for (let n = 0; n < 6; n++) {
			await vi.advanceTimersByTimeAsync(15);
			emit();
		}
		await vi.advanceTimersByTimeAsync(10);
		await rejected;
		expect(record).not.toHaveBeenCalled();
	} finally {
		vi.useRealTimers();
	}
});
