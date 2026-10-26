import { describe, expect, it } from "vite-plus/test";
import { HomeRunSteering } from "./run-steering";

describe("Home steering between rounds", () => {
	it("persists unread messages, consumes once in order, and returns only unread messages on Stop", () => {
		const values = new Map<string, unknown>();
		const storage = {
			get: <T>(key: string) => values.get(key) as T | undefined,
			put: <T>(key: string, value: T) => {
				values.set(key, value);
			},
		};
		const queue = new HomeRunSteering(storage);
		const base = { runId: "run", sessionKey: "home:fixture" };
		queue.control({ ...base, action: "enqueue", id: "a", content: "First" });
		queue.control({ ...base, action: "enqueue", id: "a", content: "First" });
		expect(() =>
			queue.control({
				...base,
				action: "enqueue",
				id: "a",
				content: "Changed",
			}),
		).toThrow();
		const reopened = new HomeRunSteering(storage);
		expect(reopened.control({ ...base, action: "inspect" })).toEqual([
			{ id: "a", content: "First", status: "queued" },
		]);
		expect(reopened.read("run")).toEqual(["First"]);
		expect(reopened.read("run")).toEqual([]);
		queue.control({ ...base, action: "enqueue", id: "b", content: "Second" });
		queue.control({ ...base, action: "enqueue", id: "c", content: "Third" });
		expect(queue.control({ ...base, action: "withdraw" })).toEqual([
			{ id: "b", content: "Second", status: "withdrawn" },
			{ id: "c", content: "Third", status: "withdrawn" },
		]);
		expect(queue.control({ ...base, action: "withdraw" })).toEqual([]);
		expect(queue.read("run")).toEqual([]);
		expect(queue.read("another-run")).toEqual([]);
	});
});
