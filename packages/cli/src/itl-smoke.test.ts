import { describe, expect, test } from "bun:test";
import { Text, useInput } from "ink";
import { render } from "ink-testing-library";
import React from "react";
import { shouldEchoSubmittedLine } from "./ink-repl";

// Compat/documentation smoke test (not a ComposerInput regression test —
// see composer-input.test.ts for that): proves `ink-testing-library`'s fake
// stdin actually drives ink@7.1.0's REAL App.js/useInput pipeline (not a
// mock of it) even though ink-testing-library was added without prior
// verification against this ink major version, and pins down the exact
// event-grouping semantics composer-input.test.ts's bursts rely on: a plain
// multi-char run is ONE synchronous useInput event, while a run containing
// backspace bytes splits into MULTIPLE synchronous events — all still
// dispatched before any React re-render. Kept as a guard so an ink or
// ink-testing-library upgrade that changes this batching surfaces here
// first, instead of as a confusing failure in the real regression tests.
//
// Note: the log is captured via a plain ref array mutated directly inside
// the useInput callback, NOT via a setState updater — React may defer
// actually invoking a setState updater function until the (asynchronously
// scheduled) render pass, so a setState-updater side effect is not a
// reliable way to observe synchronous dispatch. A ref mutation is.

interface Event {
	input: string;
	backspace: boolean;
}

function Probe({ logRef }: { logRef: React.MutableRefObject<Event[]> }) {
	useInput((input, key) => {
		logRef.current.push({ input, backspace: key.backspace });
	});
	return React.createElement(Text, null, String(logRef.current.length));
}

describe("ink-testing-library smoke test (ink@7.1.0 compat)", () => {
	test("a plain multi-char run in one chunk is ONE useInput event (ink's own paste-vs-keystroke grouping)", () => {
		const logRef = { current: [] as Event[] };
		const { stdin } = render(React.createElement(Probe, { logRef }));
		stdin.write("abc");
		expect(logRef.current).toEqual([{ input: "abc", backspace: false }]);
	});

	test("a single stdin chunk with chars + backspaces fires MULTIPLE synchronous useInput events", () => {
		const logRef = { current: [] as Event[] };
		const { stdin } = render(React.createElement(Probe, { logRef }));

		// One write() call = one synchronous 'readable' emission = one
		// handleReadable() pass over ALL parsed events from this chunk. ink's
		// own input-parser.js splits backspace bytes (0x7F) into individual
		// events (see splitBackspaceBytes), which is exactly what makes this
		// deliver multiple synchronous useInput calls from one chunk.
		stdin.write("ab\x7F\x7F");

		expect(logRef.current).toHaveLength(3);
		expect(logRef.current[0]).toEqual({ input: "ab", backspace: false });
		expect(logRef.current[1]?.backspace).toBe(true);
		expect(logRef.current[2]?.backspace).toBe(true);
	});
});

describe("slash-command transcript behavior", () => {
	test("omits slash controls so only their result enters scrollback", () => {
		expect(shouldEchoSubmittedLine("/new")).toBe(false);
		expect(shouldEchoSubmittedLine("/new focused-session")).toBe(false);
		expect(shouldEchoSubmittedLine("/exit")).toBe(false);
		expect(shouldEchoSubmittedLine("/compact")).toBe(false);
		expect(shouldEchoSubmittedLine("/help")).toBe(false);
		expect(shouldEchoSubmittedLine("/sessions")).toBe(false);
		expect(shouldEchoSubmittedLine("/approve run-1")).toBe(false);
	});

	test("keeps normal messages in the transcript", () => {
		expect(shouldEchoSubmittedLine("hello")).toBe(true);
	});
});
