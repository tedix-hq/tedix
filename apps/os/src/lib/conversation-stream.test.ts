/** Behavioral coverage for the stream primitives used by the Cap'n Web machine. */

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	type ConversationStreamFrame,
	createFrameCoalescer,
	defaultFrameScheduler,
	nextBackoffDelayMs,
	recordStreamFrame,
	STREAM_BACKOFF_MAX_MS,
	STREAM_BACKOFF_MIN_MS,
} from "./conversation-stream";
import type { RuntimeStreamEvent } from "@tedix/api-contract/schemas/runtime-submissions";

const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONVERSATION_ID = "home:main";

function event(
	overrides: Partial<RuntimeStreamEvent> = {},
): RuntimeStreamEvent {
	return {
		id: "evt-1",
		kind: "message.delta",
		conversationId: CONVERSATION_ID,
		runId: RUN_ID,
		createdAt: "2026-08-13T10:00:00.000Z",
		...overrides,
	};
}

describe("nextBackoffDelayMs", () => {
	/** Seeded source: the jitter band is asserted, never sampled. */
	const roll = (value: number) => () => value;
	/** The band's midpoint (0.85 + 0.5 * 0.3 = 1.0) reproduces the nominal step. */
	const nominal = roll(0.5);

	it("doubles from 1s and caps at 30s at the band's midpoint", () => {
		expect(
			[0, 1, 2, 3, 4, 5, 6].map((attempt) =>
				nextBackoffDelayMs(attempt, nominal),
			),
		).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
		expect(nextBackoffDelayMs(0, nominal)).toBe(STREAM_BACKOFF_MIN_MS);
	});

	it("jitters each step across a 0.85–1.15 band so tabs cannot re-dial in lockstep", () => {
		expect(nextBackoffDelayMs(0, roll(0))).toBe(850);
		expect(nextBackoffDelayMs(0, roll(1))).toBe(1150);
		expect(nextBackoffDelayMs(2, roll(0))).toBe(3400);
		expect(nextBackoffDelayMs(2, roll(1))).toBe(4600);
		// Two tabs on the same rung with different rolls do not collide.
		expect(nextBackoffDelayMs(3, roll(0.1))).not.toBe(
			nextBackoffDelayMs(3, roll(0.9)),
		);
	});

	it("never exceeds the 30s ceiling, jitter included", () => {
		expect(nextBackoffDelayMs(5, roll(1))).toBe(STREAM_BACKOFF_MAX_MS);
		expect(nextBackoffDelayMs(1000, roll(1))).toBe(STREAM_BACKOFF_MAX_MS);
		expect(nextBackoffDelayMs(5, roll(0))).toBe(25_500);
	});

	it("stays capped for huge attempt counts (no overflow) and floors negatives", () => {
		expect(nextBackoffDelayMs(1000, nominal)).toBe(STREAM_BACKOFF_MAX_MS);
		expect(nextBackoffDelayMs(-3, nominal)).toBe(STREAM_BACKOFF_MIN_MS);
	});

	it("clamps a random source that leaves [0, 1) instead of trusting it", () => {
		expect(nextBackoffDelayMs(0, roll(4))).toBe(1150);
		expect(nextBackoffDelayMs(0, roll(-4))).toBe(850);
	});

	it("uses real randomness by default, inside the band", () => {
		for (let index = 0; index < 50; index += 1) {
			const delay = nextBackoffDelayMs(2);
			expect(delay).toBeGreaterThanOrEqual(3400);
			expect(delay).toBeLessThanOrEqual(4600);
		}
	});
});

describe("recordStreamFrame", () => {
	it("keys by frame id so re-delivery is a no-op overwrite", () => {
		const frames = new Map<string, ConversationStreamFrame>();
		const frame: ConversationStreamFrame = {
			offset: 3,
			eventId: "home:main:3",
			event: event(),
		};
		expect(recordStreamFrame(frames, frame)).toBe(true);
		expect(recordStreamFrame(frames, frame)).toBe(false);
		expect(frames.size).toBe(1);
	});

	it("keeps same-offset frames from different id namespaces apart", () => {
		// The Cap'n lane's offsets are RUN-local and restart at 0 per run; an
		// offset-keyed store dropped every new run's first events as duplicates.
		const frames = new Map<string, ConversationStreamFrame>();
		expect(
			recordStreamFrame(frames, {
				offset: 0,
				eventId: "home:main:run-1:0",
				event: event({ id: "a" }),
			}),
		).toBe(true);
		expect(
			recordStreamFrame(frames, {
				offset: 0,
				eventId: "home:main:run-2:0",
				event: event({ id: "b" }),
			}),
		).toBe(true);
		expect(frames.size).toBe(2);
	});
});

describe("createFrameCoalescer", () => {
	it("flushes at most once per scheduled frame", () => {
		let flushes = 0;
		const callbacks: Array<() => void> = [];
		const coalescer = createFrameCoalescer(
			() => {
				flushes += 1;
			},
			(callback) => callbacks.push(callback),
		);
		coalescer.schedule();
		coalescer.schedule();
		coalescer.schedule();
		expect(callbacks).toHaveLength(1);
		callbacks[0]?.();
		expect(flushes).toBe(1);
		// after the frame fires, the next burst schedules a fresh flush
		coalescer.schedule();
		expect(callbacks).toHaveLength(2);
	});

	it("never flushes after dispose", () => {
		let flushes = 0;
		const callbacks: Array<() => void> = [];
		const coalescer = createFrameCoalescer(
			() => {
				flushes += 1;
			},
			(callback) => callbacks.push(callback),
		);
		coalescer.schedule();
		coalescer.dispose();
		callbacks[0]?.();
		expect(flushes).toBe(0);
	});

	describe("defaultFrameScheduler timeout fallback", () => {
		afterEach(() => {
			vi.unstubAllGlobals();
			vi.useRealTimers();
		});

		it("coalesces a delta burst into one flush per 16ms tick without rAF", () => {
			vi.useFakeTimers();
			// happy-dom provides requestAnimationFrame; remove it to exercise the
			// non-browser fallback the deliverable requires.
			vi.stubGlobal("requestAnimationFrame", undefined);
			let flushes = 0;
			const coalescer = createFrameCoalescer(() => {
				flushes += 1;
			}, defaultFrameScheduler);
			coalescer.schedule();
			coalescer.schedule();
			coalescer.schedule();
			expect(flushes).toBe(0);
			vi.advanceTimersByTime(16);
			expect(flushes).toBe(1);
			coalescer.schedule();
			vi.advanceTimersByTime(16);
			expect(flushes).toBe(2);
		});
	});
});
