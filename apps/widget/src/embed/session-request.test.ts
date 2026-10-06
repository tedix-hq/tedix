import { describe, expect, it, vi } from "vite-plus/test";
import { createInFlightRequestCoalescer } from "./session-request";

describe("embedded session request coalescing", () => {
	it("shares one in-flight request for the same conversation", async () => {
		let resolveRequest: ((value: string) => void) | undefined;
		const request = vi.fn(
			() =>
				new Promise<string>((resolve) => {
					resolveRequest = resolve;
				}),
		);
		const coalescer = createInFlightRequestCoalescer<string>();

		const first = coalescer.run("conversation-1", request);
		const second = coalescer.run("conversation-1", request);

		expect(request).toHaveBeenCalledOnce();
		resolveRequest?.("session-1");
		await expect(Promise.all([first, second])).resolves.toEqual([
			"session-1",
			"session-1",
		]);
	});

	it("does not share requests across conversations", async () => {
		const request = vi
			.fn<() => Promise<string>>()
			.mockResolvedValueOnce("session-1")
			.mockResolvedValueOnce("session-2");
		const coalescer = createInFlightRequestCoalescer<string>();

		await expect(
			Promise.all([
				coalescer.run("conversation-1", request),
				coalescer.run("conversation-2", request),
			]),
		).resolves.toEqual(["session-1", "session-2"]);
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("allows retry after a failed request settles", async () => {
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(new Error("unavailable"))
			.mockResolvedValueOnce("session-1");
		const coalescer = createInFlightRequestCoalescer<string>();

		await expect(coalescer.run("conversation-1", request)).rejects.toThrow(
			"unavailable",
		);
		await expect(coalescer.run("conversation-1", request)).resolves.toBe(
			"session-1",
		);
		expect(request).toHaveBeenCalledTimes(2);
	});
});
