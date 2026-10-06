import { describe, expect, it, vi } from "vite-plus/test";
import {
	rejectDeferredLoaderCalls,
	replayLoaderCall,
	type LoaderCall,
} from "./loader-queue";

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

	it("rejects deferred calls while retaining replayable calls after load failure", async () => {
		const queue: LoaderCall[] = [["open"]];
		const deferred: LoaderCall[] = [];
		const pending = new Promise((resolve, reject) =>
			deferred.push({ method: "ask", args: ["hello"], resolve, reject }),
		);
		const failure = new Error("runtime failed");

		rejectDeferredLoaderCalls([queue, deferred], failure);

		await expect(pending).rejects.toBe(failure);
		expect(queue).toEqual([["open"]]);
		expect(deferred).toEqual([]);
	});

	it("clears replayable and deferred calls during shutdown", async () => {
		const queue: LoaderCall[] = [["boot", {}]];
		const pending = new Promise((resolve, reject) =>
			queue.push({ method: "ask", args: ["hello"], resolve, reject }),
		);
		const failure = new Error("shutdown");

		rejectDeferredLoaderCalls([queue], failure, false);

		await expect(pending).rejects.toBe(failure);
		expect(queue).toEqual([]);
	});

	it("continues to replay legacy array entries", async () => {
		const open = vi.fn();

		await replayLoaderCall(["open"], { open });

		expect(open).toHaveBeenCalledOnce();
	});
});
