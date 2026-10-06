/**
 * Unit tests for `abortKernelTurn` — the pure logic backing
 * `KernelDOv4.cancelTurn` (`kernel-do.ts`). Extracted to a cloudflare-free
 * module (see the file's module doc) specifically so it can be unit-tested:
 * `apps/api` has no Workers-runtime vitest pool, so the Durable Object class
 * itself cannot be instantiated here.
 */

import { describe, expect, it } from "vite-plus/test";
import { abortKernelTurn } from "./turn-abort";

describe("abortKernelTurn", () => {
	it("aborts a live controller and returns true", () => {
		const controllers = new Map<string, AbortController>();
		const controller = new AbortController();
		controllers.set("run-1", controller);

		const result = abortKernelTurn(controllers, "run-1");

		expect(result).toBe(true);
		expect(controller.signal.aborted).toBe(true);
	});

	it("is a no-op (returns false) when there is no live controller for the runId", () => {
		const controllers = new Map<string, AbortController>();

		const result = abortKernelTurn(controllers, "run-does-not-exist");

		expect(result).toBe(false);
	});

	it("only aborts the targeted runId, leaving other live controllers untouched", () => {
		const controllers = new Map<string, AbortController>();
		const target = new AbortController();
		const other = new AbortController();
		controllers.set("run-1", target);
		controllers.set("run-2", other);

		const result = abortKernelTurn(controllers, "run-1");

		expect(result).toBe(true);
		expect(target.signal.aborted).toBe(true);
		expect(other.signal.aborted).toBe(false);
	});

	it("calling it twice for the same runId is safe (second call still no-throws)", () => {
		const controllers = new Map<string, AbortController>();
		const controller = new AbortController();
		controllers.set("run-1", controller);

		expect(abortKernelTurn(controllers, "run-1")).toBe(true);
		// The DO does not delete the map entry on abort itself (that happens in
		// `runPlannerStep`'s `finally` once the turn actually settles) — a second
		// cancelTurn racing in before settle must not throw.
		expect(() => abortKernelTurn(controllers, "run-1")).not.toThrow();
		expect(controller.signal.aborted).toBe(true);
	});

	it("aborts with a descriptive reason (observability — not an opaque AbortError)", () => {
		const controllers = new Map<string, AbortController>();
		const controller = new AbortController();
		controllers.set("run-42", controller);

		abortKernelTurn(controllers, "run-42");

		expect(controller.signal.reason).toBeInstanceOf(Error);
		expect((controller.signal.reason as Error).message).toContain("run-42");
		expect((controller.signal.reason as Error).message).toContain("canceled");
	});
});
