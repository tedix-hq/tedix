import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createProviderBreaker, DEFAULT_BREAKER_COOLDOWN_MS } from "./breaker";

afterEach(() => {
	vi.useRealTimers();
});

describe("createProviderBreaker", () => {
	it("starts closed", () => {
		expect(createProviderBreaker().isOpen()).toBe(false);
	});

	it("opens on trip and closes again after the cooldown", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		const breaker = createProviderBreaker(1_000);
		breaker.trip();
		expect(breaker.isOpen()).toBe(true);
		vi.advanceTimersByTime(999);
		expect(breaker.isOpen()).toBe(true);
		vi.advanceTimersByTime(1);
		expect(breaker.isOpen()).toBe(false);
	});

	it("reset closes it immediately (the success path)", () => {
		const breaker = createProviderBreaker(60_000);
		breaker.trip();
		expect(breaker.isOpen()).toBe(true);
		breaker.reset();
		expect(breaker.isOpen()).toBe(false);
	});

	it("re-tripping extends the window from now", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		const breaker = createProviderBreaker(1_000);
		breaker.trip();
		vi.advanceTimersByTime(900);
		breaker.trip();
		vi.advanceTimersByTime(900);
		expect(breaker.isOpen()).toBe(true);
	});

	it("each breaker is independent state", () => {
		const a = createProviderBreaker(60_000);
		const b = createProviderBreaker(60_000);
		a.trip();
		expect(a.isOpen()).toBe(true);
		expect(b.isOpen()).toBe(false);
	});

	it("defaults to a five-minute cooldown", () => {
		expect(DEFAULT_BREAKER_COOLDOWN_MS).toBe(300_000);
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		const breaker = createProviderBreaker();
		breaker.trip();
		vi.advanceTimersByTime(DEFAULT_BREAKER_COOLDOWN_MS - 1);
		expect(breaker.isOpen()).toBe(true);
		vi.advanceTimersByTime(1);
		expect(breaker.isOpen()).toBe(false);
	});
});
