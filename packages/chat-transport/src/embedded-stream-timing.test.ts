import { describe, expect, it } from "vite-plus/test";
import { createEmbeddedStreamTiming } from "./embedded-stream-timing";

describe("embedded stream timing", () => {
	it("separates runtime terminal arrival from delayed browser acknowledgment without retaining content", async () => {
		let now = 100;
		const timing = createEmbeddedStreamTiming(() => now);
		now = 110;
		timing.mark("authorized");
		now = 120;
		timing.mark("response");
		const frame = {
			id: "private-id",
			event: { kind: "done", text: "private answer" },
		};
		now = 200;
		timing.receive(frame);
		let release!: () => void;
		now = 250;
		const pending = timing.deliver(
			frame,
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		expect(
			timing.snapshot("run", false, "completed").stages.terminalAcknowledged,
		).toBeUndefined();
		now = 500;
		release();
		await pending;
		timing.mark("drained");
		const result = timing.snapshot("run", false, "completed");
		expect(result.stages).toEqual({
			authorized: 10,
			response: 20,
			firstFrame: 100,
			terminal: 100,
			terminalSent: 150,
			terminalAcknowledged: 400,
			drained: 400,
		});
		expect(result.maxAcknowledgmentMs).toBe(250);
		expect(result.acknowledged).toBe(1);
		expect(JSON.stringify(result)).not.toContain("private");
	});
	it("preserves rejected callbacks and counts outstanding deliveries", async () => {
		let now = 0;
		const timing = createEmbeddedStreamTiming(() => now);
		let release!: () => void;
		const frame = { id: null, event: { kind: "delta", text: "x" } };
		timing.receive(frame);
		const pending = timing.deliver(
			frame,
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		await expect(
			timing.deliver(frame, async () => {
				now = 10;
				throw new Error("callback failed");
			}),
		).rejects.toThrow("callback failed");
		release();
		await pending;
		const result = timing.snapshot("run", true, "failed");
		expect(result.maxPending).toBe(2);
		expect(result.acknowledged).toBe(1);
		expect(result.stages.firstText).toBe(0);
		expect(result.stages.terminal).toBeUndefined();
	});
});
