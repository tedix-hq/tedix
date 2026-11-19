import { describe, expect, it, vi } from "vite-plus/test";
import { replayLoaderCall, type LoaderCall } from "./loader-queue";

describe("widget loader queue", () => {
	it("settles a deferred call with the runtime result", async () => {
		const queue: LoaderCall[] = [];
		const pending = new Promise((resolve, reject) =>
			queue.push({ method: "ask", args: ["hello"], resolve, reject }),
		);
		const ask = vi.fn(async () => "answer");

		await replayLoaderCall(queue.shift()!, { ask });

		await expect(pending).resolves.toBe("answer");
		expect(ask).toHaveBeenCalledWith("hello");
	});

	it("propagates runtime rejection exactly once", async () => {
		const queue: LoaderCall[] = [];
		const pending = new Promise((resolve, reject) =>
			queue.push({
				method: "deleteConversation",
				args: ["c1"],
				resolve,
				reject,
			}),
		);
		const failure = new Error("denied");

		await replayLoaderCall(queue.shift()!, {
			deleteConversation: async () => {
				throw failure;
			},
		});

		await expect(pending).rejects.toBe(failure);
	});

	it("continues to replay legacy array entries", async () => {
		const open = vi.fn();

		await replayLoaderCall(["open"], { open });

		expect(open).toHaveBeenCalledOnce();
	});
});
