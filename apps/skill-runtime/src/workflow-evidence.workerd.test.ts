import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { withWorkflowEvidenceRetry } from "./workflow-evidence";

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("workflow evidence retry bounds", () => {
	it.each([
		NaN,
		Infinity,
		-Infinity,
		-1,
		0,
		0.5,
		1.5,
		Number.MAX_SAFE_INTEGER + 1,
	])(
		"rejects invalid attempts %s before calling the operation",
		async (attempts) => {
			const operation = vi.fn(async () => "persisted");
			const onRetry = vi.fn();
			await expect(
				withWorkflowEvidenceRetry("invalid", operation, { attempts, onRetry }),
			).rejects.toThrow("attempts must be a positive safe integer");
			expect(operation).not.toHaveBeenCalled();
			expect(onRetry).not.toHaveBeenCalled();
		},
	);

	it.each([NaN, Infinity, -Infinity, -1, 0.5, 2_147_483_648, Number.MAX_VALUE])(
		"rejects invalid base delay %s before calling the operation",
		async (baseDelayMs) => {
			const operation = vi.fn(async () => "persisted");
			await expect(
				withWorkflowEvidenceRetry("invalid", operation, { baseDelayMs }),
			).rejects.toThrow(
				"baseDelayMs must be an integer between 0 and 2147483647",
			);
			expect(operation).not.toHaveBeenCalled();
		},
	);

	it.each([1, Number.MAX_SAFE_INTEGER])(
		"calls a successful operation once with attempts %s",
		async (attempts) => {
			const operation = vi.fn(async () => "persisted");
			await expect(
				withWorkflowEvidenceRetry("success", operation, {
					attempts,
					baseDelayMs: 2_147_483_647,
				}),
			).resolves.toBe("persisted");
			expect(operation).toHaveBeenCalledTimes(1);
		},
	);

	it.each([1, 3, 1026])(
		"makes exactly %s calls and preserves the final error with zero delay",
		async (attempts) => {
			const errors: Error[] = [];
			const operation = vi.fn(async () => {
				const error = new Error(`failure ${errors.length + 1}`);
				errors.push(error);
				throw error;
			});
			const onRetry = vi.fn();
			const timer = vi.spyOn(globalThis, "setTimeout");
			const result = withWorkflowEvidenceRetry("exhausted", operation, {
				attempts,
				baseDelayMs: 0,
				onRetry,
			});
			await expect(result).rejects.toSatisfy(
				(error) => error === errors.at(-1),
			);
			expect(operation).toHaveBeenCalledTimes(attempts);
			expect(onRetry).toHaveBeenCalledTimes(attempts - 1);
			for (let index = 0; index < attempts - 1; index += 1) {
				expect(onRetry).toHaveBeenNthCalledWith(
					index + 1,
					errors[index],
					index + 1,
					"exhausted",
				);
			}
			expect(timer).not.toHaveBeenCalled();
		},
	);

	it("uses five attempts and 100ms exponential backoff by default", async () => {
		vi.useFakeTimers();
		const error = new Error("unavailable");
		const operation = vi.fn(async () => {
			throw error;
		});
		const timer = vi.spyOn(globalThis, "setTimeout");
		const result = expect(
			withWorkflowEvidenceRetry("defaults", operation),
		).rejects.toBe(error);
		await vi.runAllTimersAsync();
		await result;
		expect(operation).toHaveBeenCalledTimes(5);
		expect(timer.mock.calls.map((call) => call[1])).toEqual([
			100, 200, 400, 800,
		]);
	});

	it("caps growing backoff at the timer limit", async () => {
		vi.useFakeTimers();
		const operation = vi
			.fn()
			.mockRejectedValueOnce(new Error("first"))
			.mockRejectedValueOnce(new Error("second"))
			.mockResolvedValue("persisted");
		const timer = vi.spyOn(globalThis, "setTimeout");
		const result = withWorkflowEvidenceRetry("capped", operation, {
			attempts: 3,
			baseDelayMs: 2_147_483_647,
		});
		await vi.runAllTimersAsync();
		await expect(result).resolves.toBe("persisted");
		expect(operation).toHaveBeenCalledTimes(3);
		expect(timer.mock.calls.map((call) => call[1])).toEqual([
			2_147_483_647, 2_147_483_647,
		]);
	});

	it.each([
		"WORKFLOW_RESTART_ABORTED:",
		"WORKFLOW_EPOCH_OUTCOME_CONFLICT:",
		"WORKFLOW_RUNTIME_DRIFT_BLOCKED:",
	])("does not retry logical conflict %s", async (prefix) => {
		const error = new Error(`${prefix} conflict`);
		const operation = vi.fn(async () => {
			throw error;
		});
		const onRetry = vi.fn();
		await expect(
			withWorkflowEvidenceRetry("conflict", operation, { onRetry }),
		).rejects.toBe(error);
		expect(operation).toHaveBeenCalledTimes(1);
		expect(onRetry).not.toHaveBeenCalled();
	});
});
