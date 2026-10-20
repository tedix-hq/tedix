import { describe, expect, it, vi } from "vite-plus/test";
import { withModelFallback } from "./model-fallback";
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
	it("caps a ladder and does not revisit models across SDK retries", async () => {
		const f = fixture(async () => {
			throw { statusCode: 402 };
		});
		await f.model.doGenerate();
		await expect(f.model.doGenerate()).rejects.toEqual({ statusCode: 402 });
		expect(f.second).toHaveBeenCalledTimes(1);
	});
});

describe("stream fallback boundaries", () => {
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
