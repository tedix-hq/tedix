import { describe, expect, test } from "bun:test";
import { MESSAGE_QUEUE_LIMIT, MessageQueue } from "./message-queue";

describe("MessageQueue", () => {
	test("keeps follow-ups ordered and bounded", () => {
		const queue = new MessageQueue();
		for (let index = 0; index < MESSAGE_QUEUE_LIMIT; index++) {
			expect(queue.enqueue(`message ${index}`)).toBe(true);
		}
		expect(queue.enqueue("overflow")).toBe(false);
		expect(queue.takeNext()).toBe("message 0");
		expect(queue.list()).toEqual([
			"message 1",
			"message 2",
			"message 3",
			"message 4",
		]);
	});

	test("uses two presses to arm cancellation", () => {
		const queue = new MessageQueue();
		expect(queue.armCancel()).toBe(true);
		expect(queue.cancelArmed).toBe(true);
		expect(queue.armCancel()).toBe(false);
		queue.disarmCancel();
		expect(queue.cancelArmed).toBe(false);
	});
});
