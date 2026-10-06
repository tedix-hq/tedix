/**
 * Regression tests for the burst-data-loss fix in composer-input.tsx.
 *
 * These render the REAL ComposerInput through ink's REAL reconciler and
 * REAL `useInput` pipeline (via `ink-testing-library`, verified compatible
 * with the installed ink@8.0.0 — see itl-smoke.test.ts), and drive it
 * through a fake stdin whose `.write()` call is fed to ink's real
 * `input-parser.js` exactly the way a real stdin `readable` event would be.
 * ink's own parser splits a chunk containing backspace bytes into MULTIPLE
 * keypress events that `App.js#handleReadable` loops over and dispatches
 * SYNCHRONOUSLY, in one JS tick, before React ever gets a chance to
 * re-render; two back-to-back `.write()` calls with no `await` between them
 * are likewise both fully processed before any re-render (React's scheduler
 * defers actual flushing to a later tick) — i.e. this is the real batching
 * behavior the bug depends on, not an idealized one-event-per-call
 * simulation. A test that only called `applyComposerKey` directly (see
 * composer-editor.test.ts) would NOT catch this class of bug: the reducer
 * itself was always correct per-call, the bug was in the wrapper reading a
 * stale prop/state closure across multiple calls in the same tick.
 */

import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { Box } from "ink";
import React from "react";
import { applyComposerKey, type ComposerKey } from "./composer-editor";
import ComposerInput, { type ComposerInputProps } from "./composer-input";

function el(props: Partial<ComposerInputProps> & { value: string }) {
	return React.createElement(ComposerInput, {
		onChange: () => {},
		...props,
	});
}

function submitSpy() {
	const calls: string[] = [];
	return { calls, onSubmit: (value: string) => calls.push(value) };
}

// ── Reference oracle ─────────────────────────────────────────────────────
//
// Chains the same pure reducer the production wrapper uses, event-by-event,
// to derive the "correct if burst-threading works" value independently of
// the ink harness below. `applyComposerKey`'s per-call correctness is
// already covered by composer-editor.test.ts; here it's only used as a known
// -good oracle for what a CORRECTLY-CHAINED sequence of events must produce.
function replay(
	initial: string,
	events: Array<[string, Partial<ComposerKey>]>,
): string {
	const key = (overrides: Partial<ComposerKey>): ComposerKey => ({
		leftArrow: false,
		rightArrow: false,
		backspace: false,
		delete: false,
		return: false,
		home: false,
		end: false,
		ctrl: false,
		meta: false,
		upArrow: false,
		downArrow: false,
		tab: false,
		shift: false,
		...overrides,
	});
	let state = { value: initial, cursorOffset: Array.from(initial).length };
	let submitted: string | undefined;
	for (const [input, keyOverrides] of events) {
		const result = applyComposerKey(state, input, key(keyOverrides));
		state = result.state;
		if (result.submit !== undefined) {
			submitted = result.submit;
		}
	}
	if (submitted === undefined) {
		throw new Error("replay() sequence never reached a return/submit event");
	}
	return submitted;
}

describe("composer-input — burst data-loss regression", () => {
	test("one coalesced text+Enter chunk submits instead of rendering a literal CR", () => {
		const { onSubmit, calls } = submitSpy();
		const { stdin } = render(el({ value: "/", onSubmit }));

		stdin.write("sessions\r");

		expect(calls).toEqual(["/sessions"]);
	});

	// The exact scenario from the confirmed root-cause repro: composer renders
	// "/", then a SINGLE stdin chunk delivers a paste-like text run followed by
	// Enter, all as one synchronous burst. Pre-fix, the useInput closure read
	// the stale pre-burst `value` prop for every event in the burst — so the
	// terminating Enter always submitted the ORIGINAL "/" no matter what was
	// typed. This is the minimal 2-event burst (insert + Enter) that isolates
	// exactly that failure mode.
	//
	// The two events are also delivered as separate, back-to-back `stdin
	// .write()` calls to cover the sibling batching shape. Two synchronous calls
	// with no `await` between them is exactly the realistic shape this
	// isolates: two separate stdin reads/chunks (e.g. two separate packets
	// coalesced by a laggy ssh/tmux connection), both fully processed before
	// React ever gets a chance to re-render in between — React's scheduler
	// defers the actual flush to a later tick (ink's `discreteUpdates` only
	// sets update priority, it never calls `flushSync`), so nothing forces a
	// render between these two synchronous calls.
	test("burst = type, then Enter, as two back-to-back synchronous stdin chunks: Enter submits the EDITED value, not the stale pre-burst one", () => {
		const { onSubmit, calls } = submitSpy();
		const { stdin } = render(el({ value: "/", onSubmit }));

		stdin.write("workspaces");
		// No `await` here — this must land before any re-render, exactly like
		// the production bug's synchronous multi-event burst.
		stdin.write("\r");

		expect(calls).toEqual(["/workspaces"]);
		// The specific pre-fix failure mode: submitting the stale pre-burst
		// value instead of the edited one.
		expect(calls).not.toEqual(["/"]);
	});

	// A deeper burst — insert, then several individual backspace events (ink's
	// input-parser.js splits repeated 0x7F bytes into one event EACH, unlike
	// the plain-text run above), then Enter — all still one synchronous stdin
	// chunk. This proves chaining survives arbitrarily many interleaved edits
	// in the same burst, not just a single one.
	test("burst = type + several individual backspaces + Enter in one chunk: Enter submits the fully-chained edit", () => {
		const { onSubmit, calls } = submitSpy();
		const { stdin } = render(el({ value: "/", onSubmit }));

		const burst = `workspaces${"\x7F".repeat(5)}\r`;
		stdin.write(burst);

		// Independently-derived oracle: same event sequence, chained through
		// the pure reducer directly.
		const expected = replay("/", [
			["workspaces", {}],
			...(Array.from({ length: 5 }, () => ["", { backspace: true }]) as Array<
				[string, Partial<ComposerKey>]
			>),
			["\r", { return: true }],
		]);
		expect(expected).toBe("/works");

		expect(calls).toEqual([expected]);
		// The pre-fix bug would submit the stale pre-burst value here too.
		expect(calls).not.toEqual(["/"]);
	});

	// A burst that nets back to a no-op (type 10 chars, backspace 10 times) is
	// a degenerate case worth calling out explicitly: the mathematically
	// correct post-edit value and the pre-fix stale value are BOTH "/" here,
	// so this specific shape can't distinguish buggy from fixed code on its
	// own. It's included only to document why the two tests above
	// deliberately avoid a 1:1 insert/delete count — the net-zero case adds
	// no coverage a passing implementation couldn't fake.
	test("degenerate net-zero burst (10 chars + 10 backspaces) submits the unedited value — not a regression signal by itself", () => {
		const { onSubmit, calls } = submitSpy();
		const { stdin } = render(el({ value: "/", onSubmit }));
		stdin.write(`workspaces${"\x7F".repeat(10)}\r`);
		expect(calls).toEqual(["/"]);
	});

	test("burst ending in a bare \\r (no key.return) also submits the fully-chained edit", () => {
		const { onSubmit, calls } = submitSpy();
		const { stdin } = render(el({ value: "", onSubmit }));
		stdin.write(`hello${"\x7F".repeat(2)}\r`);
		expect(calls).toEqual(["hel"]);
	});

	// Adversarial-review-caught blocker: `pendingRef` must be reset on submit
	// itself, not just on the next external `value` prop change. Without this,
	// any event landing in the SAME synchronous burst AFTER an Enter (a laggy
	// connection delivering two lines back-to-back with no await between them,
	// or a repeated/double Enter) chains onto the just-submitted buffer
	// instead of starting clean — corrupting the next submit or firing
	// `onSubmit` twice with the same (wrongly re-prepended) value. This is
	// exactly the case none of the bursts above cover: they all place the
	// terminating Enter LAST.
	test("two submits back-to-back in one burst: the second does not re-prepend the first", () => {
		const { onSubmit, calls } = submitSpy();
		const { stdin } = render(el({ value: "", onSubmit }));

		stdin.write("line1");
		stdin.write("\r");
		stdin.write("line2");
		stdin.write("\r");

		expect(calls).toEqual(["line1", "line2"]);
		// The specific pre-fix failure mode: the second submit corrupted by
		// chaining onto the still-un-reset pre-submit buffer.
		expect(calls).not.toEqual(["line1", "line1line2"]);
	});

	test("a double Enter landing in one tick with no text between submits empty twice, not the same stale value twice", () => {
		const { onSubmit, calls } = submitSpy();
		const { stdin } = render(el({ value: "line1", onSubmit }));

		stdin.write("\r");
		stdin.write("\r");

		expect(calls).toEqual(["line1", ""]);
		// The specific pre-fix failure mode: onSubmit fires twice with the
		// IDENTICAL un-reset value, i.e. the same message dispatched twice.
		expect(calls).not.toEqual(["line1", "line1"]);
	});
});

describe("composer-input — external value sync (must not fight pendingRef)", () => {
	// Simulates ink-repl.tsx's history-nav / Ctrl-L pattern: the parent
	// replaces `value` from OUTSIDE the composer's own onChange loop (a plain
	// rerender with a new prop, not something the composer itself emitted).
	// The composer's internal ref must adopt that new value, not fight it —
	// so a burst typed AFTER the external reset must chain off the NEW value.
	test("an externally-replaced value prop is adopted, and the next burst chains off of it", () => {
		const { onSubmit, calls } = submitSpy();
		const { stdin, rerender } = render(el({ value: "hello", onSubmit }));

		// External replacement (e.g. arrow-up history recall), NOT driven by
		// this composer's own onChange.
		rerender(el({ value: "world", onSubmit }));

		stdin.write("!");
		stdin.write("\r");

		expect(calls).toEqual(["world!"]);
	});

	// Ctrl-L-style clear: parent resets to "" from outside, then the user
	// starts typing fresh — must not resurrect the pre-clear text.
	test("an external reset to empty string is adopted (Ctrl-L clear pattern)", () => {
		const { onSubmit, calls } = submitSpy();
		const { stdin, rerender } = render(
			el({ value: "leftover text", onSubmit }),
		);

		rerender(el({ value: "", onSubmit }));

		stdin.write("hi");
		stdin.write("\r");

		expect(calls).toEqual(["hi"]);
	});
});

describe("composer-input — ordinary (non-burst) controlled round-trip still works", () => {
	// Baseline sanity: sequential, separately-flushed keystrokes (the common
	// case, not a burst) must still behave like a normal controlled text
	// input across multiple render cycles. Each `rerender` call here plays
	// the role of the parent's own re-render after receiving `onChange`
	// (ink-repl.tsx's `setInputValue`), synchronously driven via
	// `ink-testing-library`'s `rerender` so the test doesn't depend on
	// Scheduler flush timing.
	test("typing several separate keystrokes across separate render cycles accumulates correctly", () => {
		const { onSubmit, calls } = submitSpy();
		let current = "";
		const onChange = (value: string) => {
			current = value;
		};
		const { stdin, rerender } = render(
			el({ value: current, onChange, onSubmit }),
		);

		stdin.write("a");
		rerender(el({ value: current, onChange, onSubmit }));
		expect(current).toBe("a");

		stdin.write("b");
		rerender(el({ value: current, onChange, onSubmit }));
		expect(current).toBe("ab");

		stdin.write("c");
		rerender(el({ value: current, onChange, onSubmit }));
		expect(current).toBe("abc");

		stdin.write("\r");
		expect(calls).toEqual(["abc"]);
	});
});

describe("composer-input — multiline paste and Unicode bursts", () => {
	test("bracketed paste preserves trailing newlines and never submits", () => {
		const { onSubmit, calls } = submitSpy();
		let current = "";
		const { stdin } = render(
			el({
				value: "",
				onSubmit,
				onChange: (value) => {
					current = value;
				},
			}),
		);
		stdin.write("\x1b[200~first\nsecond\n\x1b[201~");
		expect(current).toBe("first\nsecond\n");
		expect(calls).toEqual([]);
		stdin.write("\r");
		expect(calls).toEqual(["first\nsecond\n"]);
	});
	test("paste and subsequent typed events share the authoritative burst buffer", () => {
		const { onSubmit, calls } = submitSpy();
		const { stdin } = render(el({ value: "", onSubmit }));
		stdin.write("\x1b[200~👨‍👩‍👧‍👦\n🇫🇮\x1b[201~");
		stdin.write("\x7f");
		stdin.write("e");
		stdin.write("\u0301");
		stdin.write("\r");
		expect(calls).toEqual(["👨‍👩‍👧‍👦\né"]);
	});
	test("portable Alt+Enter inserts a newline before a later Enter submits", () => {
		const { onSubmit, calls } = submitSpy();
		const { stdin } = render(el({ value: "first", onSubmit }));
		stdin.write("\x1b\r");
		stdin.write("second");
		expect(calls).toEqual([]);
		stdin.write("\r");
		expect(calls).toEqual(["first\nsecond"]);
	});
	test("Kitty Shift+Enter inserts an explicit newline", () => {
		const { onSubmit, calls } = submitSpy();
		const { stdin } = render(el({ value: "first", onSubmit }));
		stdin.write("\x1b[13;2u");
		stdin.write("second");
		stdin.write("\r");
		expect(calls).toEqual(["first\nsecond"]);
	});
	test("maxRows clips the visible draft while Enter retains every line", () => {
		const { onSubmit, calls } = submitSpy();
		const value = "one\ntwo\nthree\nfour\nfive";
		const { stdin, lastFrame } = render(el({ value, maxRows: 2, onSubmit }));
		expect(lastFrame()).toBe("four\nfive");
		stdin.write("\r");
		expect(calls).toEqual([value]);
	});
	test("unfocused composer does not consume paste or typed input", () => {
		let changed = false;
		const { stdin } = render(
			el({
				value: "",
				focus: false,
				onChange: () => {
					changed = true;
				},
			}),
		);
		stdin.write("\x1b[200~ignored\x1b[201~");
		stdin.write("ignored");
		expect(changed).toBe(false);
	});
});

async function waitForComposerFrame(
	frame: { lastFrame: () => string | undefined },
	expected: string,
): Promise<void> {
	const deadline = Date.now() + 5000;
	while (frame.lastFrame() !== expected && Date.now() < deadline)
		await Bun.sleep(10);
	expect(frame.lastFrame()).toBe(expected);
}

test("composer measures its own content width and follows cursor after wrapping", async () => {
	const { onSubmit, calls } = submitSpy();
	const value = "界界界界";
	const frame = render(
		React.createElement(Box, { width: 4 }, el({ value, maxRows: 2, onSubmit })),
	);
	await waitForComposerFrame(frame, "界界\n");
	frame.stdin.write("\r");
	expect(calls).toEqual([value]);
});

test("tabbed paste wraps within measured rows and keeps full tabs on submit", async () => {
	const { onSubmit, calls } = submitSpy();
	let value = "";
	const onChange = (next: string) => {
		value = next;
	};
	const element = () =>
		React.createElement(
			Box,
			{ width: 4 },
			el({ value, maxRows: 2, onChange, onSubmit }),
		);
	const frame = render(element());
	frame.stdin.write("\x1b[200~a\tb\x1b[201~");
	frame.rerender(element());
	await waitForComposerFrame(frame, "\nb");
	frame.stdin.write("\r");
	expect(calls).toEqual(["a\tb"]);
});

test("empty narrow composer keeps placeholder within one row for clean exit", async () => {
	const frame = render(
		React.createElement(
			Box,
			{ width: 4 },
			el({ value: "", placeholder: "Send a message", maxRows: 4 }),
		),
	);
	await waitForComposerFrame(frame, "Send");
	frame.unmount();
});

describe("composer-input — measured rows and vertical bursts", () => {
	test("paste, Up, insert, Enter preserve CJK display column within one burst", () => {
		const { onSubmit, calls } = submitSpy();
		const { stdin } = render(el({ value: "", onSubmit }));
		stdin.write("\x1b[200~界界\nab\x1b[201~");
		stdin.write("\x1b[A");
		stdin.write("X");
		stdin.write("\r");
		expect(calls).toEqual(["界X界\nab"]);
	});
	test("reports uncapped measured rows synchronously for wrapped burst ownership", async () => {
		const rows: number[] = [];
		const { onSubmit, calls } = submitSpy();
		const frame = render(
			React.createElement(
				Box,
				{ width: 4 },
				el({
					value: "",
					maxRows: 1,
					onSubmit,
					onContentRowsChange: (count) => rows.push(count),
				}),
			),
		);
		await new Promise((resolve) => setTimeout(resolve, 30));
		frame.stdin.write("\x1b[200~abcdefghij\x1b[201~");
		expect(rows.at(-1)).toBe(3);
		frame.stdin.write("\x1b[A");
		frame.stdin.write("X");
		frame.stdin.write("\r");
		expect(calls).toEqual(["abcdefXghij"]);
		expect(rows.at(-1)).toBe(1);
	});
	test("reports width changes and external replacements using complete draft", async () => {
		const rows: number[] = [];
		const onContentRowsChange = (count: number) => rows.push(count);
		const node = (width: number, value: string) =>
			React.createElement(
				Box,
				{ width },
				el({ value, maxRows: 1, onContentRowsChange }),
			);
		const frame = render(node(8, "abcdefghij"));
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(rows.at(-1)).toBe(2);
		frame.rerender(node(4, "abcdefghij"));
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(rows.at(-1)).toBe(3);
		frame.rerender(node(4, ""));
		expect(rows.at(-1)).toBe(1);
	});
	test("preferred column survives consecutive Up events before React renders", () => {
		const { onSubmit, calls } = submitSpy();
		const frame = render(el({ value: "abcdef\nx\nabcdef", onSubmit }));
		frame.stdin.write("\x1b[A");
		frame.stdin.write("\x1b[A");
		frame.stdin.write("X");
		frame.stdin.write("\r");
		expect(calls).toEqual(["abcdefX\nx\nabcdef"]);
	});
	test("per-event ownership predicate stops typed, paste and cursor mutation", () => {
		let active = true;
		const { onSubmit, calls } = submitSpy();
		const frame = render(
			el({ value: "one\ntwo", isInputActive: () => active, onSubmit }),
		);
		active = false;
		frame.stdin.write("\x1b[A");
		frame.stdin.write("X");
		frame.stdin.write("\x1b[200~ignored\x1b[201~");
		active = true;
		frame.stdin.write("\r");
		expect(calls).toEqual(["one\ntwo"]);
	});
});
