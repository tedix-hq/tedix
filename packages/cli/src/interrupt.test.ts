import { describe, expect, test } from "bun:test";
import { classifyInterrupt, resetTerminalModes } from "./interrupt";

// ---------------------------------------------------------------------------
// classifyInterrupt
// ---------------------------------------------------------------------------

describe("classifyInterrupt", () => {
	// non-TTY always exits regardless of other state
	describe("non-TTY", () => {
		test("turn running, first press → exit", () => {
			expect(
				classifyInterrupt({
					isTty: false,
					turnRunning: true,
					secondPressWithinWindow: false,
					hasText: false,
				}),
			).toBe("exit");
		});

		test("turn running, second press → exit", () => {
			expect(
				classifyInterrupt({
					isTty: false,
					turnRunning: true,
					secondPressWithinWindow: true,
					hasText: false,
				}),
			).toBe("exit");
		});

		test("turn idle, has text → exit", () => {
			expect(
				classifyInterrupt({
					isTty: false,
					turnRunning: false,
					secondPressWithinWindow: false,
					hasText: true,
				}),
			).toBe("exit");
		});

		test("turn idle, no text → exit", () => {
			expect(
				classifyInterrupt({
					isTty: false,
					turnRunning: false,
					secondPressWithinWindow: false,
					hasText: false,
				}),
			).toBe("exit");
		});
	});

	// TTY + turn running
	describe("TTY, turn running", () => {
		test("first Ctrl-C → prompt", () => {
			expect(
				classifyInterrupt({
					isTty: true,
					turnRunning: true,
					secondPressWithinWindow: false,
					hasText: false,
				}),
			).toBe("prompt");
		});

		test("second Ctrl-C within window → abort", () => {
			expect(
				classifyInterrupt({
					isTty: true,
					turnRunning: true,
					secondPressWithinWindow: true,
					hasText: false,
				}),
			).toBe("abort");
		});

		test("first Ctrl-C with text in buffer → prompt (turn takes priority)", () => {
			expect(
				classifyInterrupt({
					isTty: true,
					turnRunning: true,
					secondPressWithinWindow: false,
					hasText: true,
				}),
			).toBe("prompt");
		});

		test("second Ctrl-C with text in buffer → abort", () => {
			expect(
				classifyInterrupt({
					isTty: true,
					turnRunning: true,
					secondPressWithinWindow: true,
					hasText: true,
				}),
			).toBe("abort");
		});
	});

	// TTY + idle REPL
	describe("TTY, turn idle", () => {
		test("has text → clear", () => {
			expect(
				classifyInterrupt({
					isTty: true,
					turnRunning: false,
					secondPressWithinWindow: false,
					hasText: true,
				}),
			).toBe("clear");
		});

		test("empty buffer → exit", () => {
			expect(
				classifyInterrupt({
					isTty: true,
					turnRunning: false,
					secondPressWithinWindow: false,
					hasText: false,
				}),
			).toBe("exit");
		});

		test("secondPressWithinWindow irrelevant when idle, has text → clear", () => {
			expect(
				classifyInterrupt({
					isTty: true,
					turnRunning: false,
					secondPressWithinWindow: true,
					hasText: true,
				}),
			).toBe("clear");
		});

		test("secondPressWithinWindow irrelevant when idle, no text → exit", () => {
			expect(
				classifyInterrupt({
					isTty: true,
					turnRunning: false,
					secondPressWithinWindow: true,
					hasText: false,
				}),
			).toBe("exit");
		});
	});
});

// ---------------------------------------------------------------------------
// resetTerminalModes
// ---------------------------------------------------------------------------

describe("resetTerminalModes", () => {
	test("writes the input-mode reset sequences", () => {
		const chunks: string[] = [];
		resetTerminalModes((s) => chunks.push(s));
		expect(chunks).toContain("\x1B[?1000l"); // mouse tracking off
		expect(chunks).toContain("\x1B[?1006l"); // SGR mouse off
		expect(chunks).toContain("\x1B[?2004l"); // bracketed paste off
	});

	test("does NOT emit ?1049l (would clear the screen on startup)", () => {
		const chunks: string[] = [];
		resetTerminalModes((s) => chunks.push(s));
		expect(chunks).not.toContain("\x1B[?1049l");
	});

	test("writes in the documented order", () => {
		const chunks: string[] = [];
		resetTerminalModes((s) => chunks.push(s));
		expect(chunks).toEqual(["\x1B[?1000l", "\x1B[?1006l", "\x1B[?2004l"]);
	});

	test("uses the injected writer, not stdout directly", () => {
		let called = false;
		resetTerminalModes(() => {
			called = true;
		});
		expect(called).toBe(true);
	});
});
