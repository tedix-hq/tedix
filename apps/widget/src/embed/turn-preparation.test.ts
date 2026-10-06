import { describe, expect, it, vi } from "vite-plus/test";
import { waitForTurnPreparation } from "./turn-preparation";

describe("turn preparation", () => {
	it("stops before a late host response can dispatch a turn", async () => {
		let finish!: (value: string) => void;
		const host = new Promise<string>((resolve) => {
			finish = resolve;
		});
		const controller = new AbortController();
		const dispatch = vi.fn();
		const turn = waitForTurnPreparation(host, controller.signal).then(dispatch);
		controller.abort();
		await expect(turn).rejects.toMatchObject({ name: "AbortError" });
		finish("host context");
		await Promise.resolve();
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("bounds a host or session request which never resolves", async () => {
		vi.useFakeTimers();
		try {
			const turn = waitForTurnPreparation(
				new Promise(() => {}),
				new AbortController().signal,
			);
			const failure = expect(turn).rejects.toThrow(
				"Subscription ended before completion",
			);
			await vi.advanceTimersByTimeAsync(150_000);
			await failure;
		} finally {
			vi.useRealTimers();
		}
	});

	it("returns successful preparation once and removes the wait", async () => {
		const controller = new AbortController();
		expect(
			await waitForTurnPreparation(
				Promise.resolve("context"),
				controller.signal,
			),
		).toBe("context");
		controller.abort();
	});
});
