import { describe, expect, test } from "bun:test";
import {
	applyComposerKey,
	type ComposerKey,
	type EditorState,
	wordBoundaryAfter,
	wordBoundaryBefore,
} from "./composer-editor";

/** All-false key baseline — tests override only the fields they need. */
const NO_KEY: ComposerKey = {
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
};

function key(overrides: Partial<ComposerKey>): ComposerKey {
	return { ...NO_KEY, ...overrides };
}

function state(value: string, cursorOffset: number): EditorState {
	return { value, cursorOffset };
}

describe("composer-editor — wordBoundaryBefore / wordBoundaryAfter", () => {
	test("skips whitespace then the non-whitespace token before the cursor", () => {
		// "foo.bar baz" — cursor at end (11): first stop is the start of "baz".
		expect(wordBoundaryBefore("foo.bar baz", 11)).toBe(8);
	});

	test("dotted token deletes as ONE unit — punctuation is not a boundary", () => {
		// From index 8 ("foo.bar " with trailing space), the whole "foo.bar "
		// run (space + non-whitespace token) is skipped as one unit.
		expect(wordBoundaryBefore("foo.bar ", 8)).toBe(0);
	});

	test("cursor at 0 is a no-op boundary", () => {
		expect(wordBoundaryBefore("abc", 0)).toBe(0);
	});

	test("mid-leading-whitespace: skips only the whitespace run before the cursor", () => {
		// "   abc" cursor at 2 (inside the leading whitespace run) → boundary is 0
		// (skip the 2 whitespace chars before the cursor; nothing non-whitespace follows).
		expect(wordBoundaryBefore("   abc", 2)).toBe(0);
	});

	test("wordBoundaryAfter skips whitespace then the token after the cursor", () => {
		// "foo.bar baz" cursor at 0 → lands right at the space (end of "foo.bar").
		expect(wordBoundaryAfter("foo.bar baz", 0)).toBe(7);
	});

	test("wordBoundaryAfter from inside trailing whitespace runs to string end", () => {
		expect(wordBoundaryAfter("abc   ", 3)).toBe(6);
	});

	test("never throws on empty string", () => {
		expect(wordBoundaryBefore("", 0)).toBe(0);
		expect(wordBoundaryAfter("", 0)).toBe(0);
	});

	test("clamps an out-of-range cursorOffset instead of throwing", () => {
		expect(wordBoundaryBefore("abc", 99)).toBe(0);
		expect(wordBoundaryAfter("abc", -5)).toBe(3);
	});

	test("is codepoint-safe around an emoji (surrogate pair)", () => {
		// "hi 😀 there" — cursor placed right after the emoji codepoint.
		const value = "hi 😀 there";
		const emojiEnd = Array.from("hi 😀").length; // codepoint index after emoji
		const before = wordBoundaryBefore(value, emojiEnd);
		// Must land on a codepoint boundary — reconstructing the string from
		// Array.from() slices must not throw or produce a lone surrogate.
		const chars = Array.from(value);
		expect(chars.slice(before, emojiEnd).join("")).toBe("😀");
	});
});

describe("composer-editor — plain character input", () => {
	test("inserts a single printable char at the cursor and advances by 1", () => {
		const { state: next } = applyComposerKey(state("helo", 3), "l", key({}));
		expect(next).toEqual({ value: "hello", cursorOffset: 4 });
	});

	test("inserts at cursor 0 (prepend)", () => {
		const { state: next } = applyComposerKey(state("bc", 0), "a", key({}));
		expect(next).toEqual({ value: "abc", cursorOffset: 1 });
	});

	test("a multi-char paste inserts the WHOLE string in one call", () => {
		const { state: next } = applyComposerKey(
			state("ac", 1),
			"PASTED-TEXT",
			key({}),
		);
		expect(next).toEqual({ value: "aPASTED-TEXTc", cursorOffset: 12 });
	});

	test("replays a coalesced Ctrl-U before following text instead of inserting it", () => {
		const { state: next } = applyComposerKey(
			state("/sessions", 9),
			"\u0015@pack",
			key({}),
		);
		expect(next).toEqual({ value: "@pack", cursorOffset: 5 });
	});

	test("keeps a coalesced Ctrl-K plus Enter as one edited submission", () => {
		const result = applyComposerKey(
			state("review stale", 6),
			"\u000bnow\r",
			key({}),
		);
		expect(result).toEqual({
			state: { value: "reviewnow", cursorOffset: 9 },
			submit: "reviewnow",
		});
	});

	test("inserting an emoji does not split it — cursor advances by 1 codepoint", () => {
		const { state: next } = applyComposerKey(state("hi ", 3), "😀", key({}));
		expect(next).toEqual({ value: "hi 😀", cursorOffset: 4 });
	});
});

describe("composer-editor — plain arrow movement (no meta)", () => {
	test("leftArrow moves cursor back by 1", () => {
		const { state: next } = applyComposerKey(
			state("hello", 3),
			"",
			key({ leftArrow: true }),
		);
		expect(next).toEqual({ value: "hello", cursorOffset: 2 });
	});

	test("leftArrow at cursor 0 clamps (no negative offset)", () => {
		const { state: next } = applyComposerKey(
			state("hello", 0),
			"",
			key({ leftArrow: true }),
		);
		expect(next).toEqual({ value: "hello", cursorOffset: 0 });
	});

	test("rightArrow moves cursor forward by 1", () => {
		const { state: next } = applyComposerKey(
			state("hello", 3),
			"",
			key({ rightArrow: true }),
		);
		expect(next).toEqual({ value: "hello", cursorOffset: 4 });
	});

	test("rightArrow at end clamps (no overflow)", () => {
		const { state: next } = applyComposerKey(
			state("hello", 5),
			"",
			key({ rightArrow: true }),
		);
		expect(next).toEqual({ value: "hello", cursorOffset: 5 });
	});
});

describe("composer-editor — plain backspace/delete (no meta), codepoint-aware", () => {
	test("backspace removes 1 char before the cursor", () => {
		const { state: next } = applyComposerKey(
			state("hello", 5),
			"",
			key({ backspace: true }),
		);
		expect(next).toEqual({ value: "hell", cursorOffset: 4 });
	});

	test("backspace at cursor 0 is a no-op", () => {
		const { state: next } = applyComposerKey(
			state("hello", 0),
			"",
			key({ backspace: true }),
		);
		expect(next).toEqual({ value: "hello", cursorOffset: 0 });
	});

	test("delete removes 1 char at the cursor (forward)", () => {
		const { state: next } = applyComposerKey(
			state("hello", 2),
			"",
			key({ delete: true }),
		);
		expect(next).toEqual({ value: "helo", cursorOffset: 2 });
	});

	test("delete at end of string is a no-op", () => {
		const { state: next } = applyComposerKey(
			state("hello", 5),
			"",
			key({ delete: true }),
		);
		expect(next).toEqual({ value: "hello", cursorOffset: 5 });
	});

	test("backspace does not split an emoji surrogate pair", () => {
		const value = "hi 😀";
		const end = Array.from(value).length;
		const { state: next } = applyComposerKey(
			state(value, end),
			"",
			key({ backspace: true }),
		);
		expect(next).toEqual({ value: "hi ", cursorOffset: 3 });
	});
});

describe("composer-editor — word jump: meta+leftArrow/rightArrow, ESC+b/f", () => {
	test("meta+leftArrow jumps to wordBoundaryBefore", () => {
		const { state: next } = applyComposerKey(
			state("foo.bar baz", 11),
			"",
			key({ leftArrow: true, meta: true }),
		);
		expect(next).toEqual({ value: "foo.bar baz", cursorOffset: 8 });
	});

	test("meta+rightArrow jumps to wordBoundaryAfter", () => {
		const { state: next } = applyComposerKey(
			state("foo.bar baz", 0),
			"",
			key({ rightArrow: true, meta: true }),
		);
		expect(next).toEqual({ value: "foo.bar baz", cursorOffset: 7 });
	});

	test("ESC+b (meta, input='b', no leftArrow flag) jumps back a word", () => {
		const { state: next } = applyComposerKey(
			state("foo.bar baz", 11),
			"b",
			key({ meta: true }),
		);
		expect(next).toEqual({ value: "foo.bar baz", cursorOffset: 8 });
	});

	test("ESC+f (meta, input='f', no rightArrow flag) jumps forward a word", () => {
		const { state: next } = applyComposerKey(
			state("foo.bar baz", 0),
			"f",
			key({ meta: true }),
		);
		expect(next).toEqual({ value: "foo.bar baz", cursorOffset: 7 });
	});

	test("plain 'b'/'f' with no meta insert the literal character", () => {
		const { state: next } = applyComposerKey(state("ar", 0), "b", key({}));
		expect(next).toEqual({ value: "bar", cursorOffset: 1 });
	});
});

describe("composer-editor — word delete: meta+backspace/delete, Ctrl-W", () => {
	test("meta+backspace (Option+Backspace) deletes the trailing dotted token as one unit", () => {
		const { state: next } = applyComposerKey(
			state("foo.bar baz", 11),
			"",
			key({ backspace: true, meta: true }),
		);
		expect(next).toEqual({ value: "foo.bar ", cursorOffset: 8 });
	});

	test("a second meta+backspace deletes 'foo.bar ' as one unit (whitespace-only boundary)", () => {
		const { state: next } = applyComposerKey(
			state("foo.bar ", 8),
			"",
			key({ backspace: true, meta: true }),
		);
		expect(next).toEqual({ value: "", cursorOffset: 0 });
	});

	test("meta+backspace at cursor 0 is a no-op", () => {
		const { state: next } = applyComposerKey(
			state("abc", 0),
			"",
			key({ backspace: true, meta: true }),
		);
		expect(next).toEqual({ value: "abc", cursorOffset: 0 });
	});

	test("meta+delete (Option+Delete forward) deletes the token ahead as one unit", () => {
		const { state: next } = applyComposerKey(
			state("foo.bar baz", 0),
			"",
			key({ delete: true, meta: true }),
		);
		// Removes "foo.bar" only (whitespace-only boundary rule) — the space
		// before "baz" is untouched since it lies AFTER the deleted token.
		expect(next).toEqual({ value: " baz", cursorOffset: 0 });
	});

	test("Ctrl-W (unix-word-rubout) behaves exactly like Option+Backspace", () => {
		const { state: next } = applyComposerKey(
			state("foo.bar baz", 11),
			"w",
			key({ ctrl: true }),
		);
		expect(next).toEqual({ value: "foo.bar ", cursorOffset: 8 });
	});

	test("Ctrl-W at cursor 0 is a no-op", () => {
		const { state: next } = applyComposerKey(
			state("abc", 0),
			"w",
			key({ ctrl: true }),
		);
		expect(next).toEqual({ value: "abc", cursorOffset: 0 });
	});

	test("word-delete does not corrupt an emoji", () => {
		const value = "hi 😀 there";
		const cursor = Array.from(value).length; // end
		const { state: next } = applyComposerKey(
			state(value, cursor),
			"",
			key({ backspace: true, meta: true }),
		);
		// Deletes "there" only — the emoji token stays intact.
		expect(next.value).toBe("hi 😀 ");
	});
});

describe("composer-editor — Home/End, Ctrl-A/E", () => {
	test("home moves cursor to 0", () => {
		const { state: next } = applyComposerKey(
			state("hello", 3),
			"",
			key({ home: true }),
		);
		expect(next).toEqual({ value: "hello", cursorOffset: 0 });
	});

	test("Ctrl-A behaves like Home", () => {
		const { state: next } = applyComposerKey(
			state("hello", 3),
			"a",
			key({ ctrl: true }),
		);
		expect(next).toEqual({ value: "hello", cursorOffset: 0 });
	});

	test("end moves cursor to the codepoint length", () => {
		const { state: next } = applyComposerKey(
			state("hello", 1),
			"",
			key({ end: true }),
		);
		expect(next).toEqual({ value: "hello", cursorOffset: 5 });
	});

	test("Ctrl-E behaves like End", () => {
		const { state: next } = applyComposerKey(
			state("hello", 1),
			"e",
			key({ ctrl: true }),
		);
		expect(next).toEqual({ value: "hello", cursorOffset: 5 });
	});

	test("End is codepoint-aware past an emoji", () => {
		const value = "hi 😀";
		const { state: next } = applyComposerKey(
			state(value, 0),
			"",
			key({ end: true }),
		);
		expect(next).toEqual({ value, cursorOffset: Array.from(value).length });
	});
});

describe("composer-editor — Ctrl-K (kill-to-end) / Ctrl-U (kill-to-start)", () => {
	test("Ctrl-K deletes from cursor to end, cursor unchanged", () => {
		const { state: next } = applyComposerKey(
			state("hello world", 5),
			"k",
			key({ ctrl: true }),
		);
		expect(next).toEqual({ value: "hello", cursorOffset: 5 });
	});

	test("Ctrl-K at cursor 0 clears the whole line, cursor stays 0", () => {
		const { state: next } = applyComposerKey(
			state("hello", 0),
			"k",
			key({ ctrl: true }),
		);
		expect(next).toEqual({ value: "", cursorOffset: 0 });
	});

	test("Ctrl-K at end of string is a no-op", () => {
		const { state: next } = applyComposerKey(
			state("hello", 5),
			"k",
			key({ ctrl: true }),
		);
		expect(next).toEqual({ value: "hello", cursorOffset: 5 });
	});

	test("Ctrl-U deletes from start to cursor, cursor moves to 0", () => {
		const { state: next } = applyComposerKey(
			state("hello world", 6),
			"u",
			key({ ctrl: true }),
		);
		expect(next).toEqual({ value: "world", cursorOffset: 0 });
	});

	test("Ctrl-U at cursor 0 is a no-op", () => {
		const { state: next } = applyComposerKey(
			state("hello", 0),
			"u",
			key({ ctrl: true }),
		);
		expect(next).toEqual({ value: "hello", cursorOffset: 0 });
	});

	test("Ctrl-U at end of string clears the whole line", () => {
		const { state: next } = applyComposerKey(
			state("hello", 5),
			"u",
			key({ ctrl: true }),
		);
		expect(next).toEqual({ value: "", cursorOffset: 0 });
	});
});

describe("composer-editor — return submits without further mutation", () => {
	test("return signals submit with the current value and leaves state untouched", () => {
		const result = applyComposerKey(
			state("hello", 3),
			"",
			key({ return: true }),
		);
		expect(result.submit).toBe("hello");
		expect(result.state).toEqual({ value: "hello", cursorOffset: 3 });
	});

	// Regression: ink's non-kitty parser special-cases raw LF (Ctrl-J) as
	// name:"enter" WITHOUT setting key.ctrl or key.return, so `input` arrives
	// as a bare "\n" with every ComposerKey flag false. Must submit, not
	// splice a newline into the single-line buffer.
	test("Ctrl-J (raw LF, no key flags set) submits instead of inserting a newline", () => {
		const result = applyComposerKey(state("hello", 3), "\n", key({}));
		expect(result.submit).toBe("hello");
		expect(result.state).toEqual({ value: "hello", cursorOffset: 3 });
	});

	test("a bare CR in `input` with no key flags also submits", () => {
		const result = applyComposerKey(state("hello", 3), "\r", key({}));
		expect(result.submit).toBe("hello");
		expect(result.state).toEqual({ value: "hello", cursorOffset: 3 });
	});

	test("a text run coalesced with trailing CR applies the edit and submits", () => {
		const result = applyComposerKey(state("/", 1), "sessions\r", key({}));
		expect(result).toEqual({
			state: { value: "/sessions", cursorOffset: 9 },
			submit: "/sessions",
		});
	});

	test("embedded newlines remain paste content instead of executing commands", () => {
		const result = applyComposerKey(state("", 0), "first\nsecond\n", key({}));
		expect(result.submit).toBeUndefined();
		expect(result.state.value).toBe("first\nsecond\n");
	});
});

describe("composer-editor — outer-owned no-ops (mirrors ink-text-input's guard list + Ctrl-D/Ctrl-L)", () => {
	const outerOwned: { name: string; k: ComposerKey; input?: string }[] = [
		{ name: "upArrow", k: key({ upArrow: true }) },
		{ name: "downArrow", k: key({ downArrow: true }) },
		{ name: "tab", k: key({ tab: true }) },
		{ name: "shift+tab", k: key({ tab: true, shift: true }) },
		{ name: "ctrl+c", k: key({ ctrl: true }), input: "c" },
		{ name: "ctrl+d", k: key({ ctrl: true }), input: "d" },
		{ name: "ctrl+l", k: key({ ctrl: true }), input: "l" },
	];

	for (const { name, k, input } of outerOwned) {
		test(`${name} leaves composer state exactly unchanged`, () => {
			const before = state("some text", 4);
			const result = applyComposerKey(before, input ?? "", k);
			expect(result.state).toEqual(before);
			expect(result.submit).toBeUndefined();
		});
	}
});

describe("composer-editor — safe-ignore of unbound ctrl/meta chords", () => {
	const unboundCtrlLetters = ["z", "x", "n", "p", "r", "g", "y", "t", "v", "_"];
	for (const letter of unboundCtrlLetters) {
		test(`ctrl+${letter} is absorbed, never inserted as text`, () => {
			const before = state("some text", 4);
			const result = applyComposerKey(before, letter, key({ ctrl: true }));
			expect(result.state).toEqual(before);
			expect(result.submit).toBeUndefined();
		});
	}

	// b/f are explicitly bound (word jump); every other bare meta+letter must
	// be safely ignored rather than inserting the literal letter.
	const unboundMetaLetters = ["d", "g", "h", "m", "n", "s", "t", "y"];
	for (const letter of unboundMetaLetters) {
		test(`meta+${letter} (ESC+letter) is absorbed, never inserted as text`, () => {
			const before = state("some text", 4);
			const result = applyComposerKey(before, letter, key({ meta: true }));
			expect(result.state).toEqual(before);
			expect(result.submit).toBeUndefined();
		});
	}

	test("the historic worst-case bug: Ctrl-W on a non-empty line no longer inserts 'w'", () => {
		const result = applyComposerKey(
			state("hello world", 11),
			"w",
			key({ ctrl: true }),
		);
		expect(result.state.value).not.toContain("hello worldw");
		expect(result.state.value).toBe("hello ");
	});
});

describe("composer-editor — extended graphemes and multiline editing", () => {
	for (const cluster of ["👨‍👩‍👧‍👦", "e\u0301", "🇫🇮", "界"]) {
		test(`moves and deletes ${cluster} as one visible unit`, () => {
			const before = state(`a${cluster}b`, 2);
			expect(
				applyComposerKey(before, "", key({ leftArrow: true })).state
					.cursorOffset,
			).toBe(1);
			expect(
				applyComposerKey(before, "", key({ backspace: true })).state,
			).toEqual(state("ab", 1));
			expect(
				applyComposerKey(state(before.value, 1), "", key({ delete: true }))
					.state,
			).toEqual(state("ab", 1));
		});
	}
	test("a combining character arriving in a later input event merges safely", () => {
		const first = applyComposerKey(state("", 0), "e", key({})).state;
		const second = applyComposerKey(first, "\u0301", key({})).state;
		expect(second).toEqual(state("é", 1));
		expect(
			applyComposerKey(second, "", key({ backspace: true })).state,
		).toEqual(state("", 0));
	});
	for (const modifier of [{ shift: true }, { meta: true }]) {
		test(`modified Enter inserts a newline (${JSON.stringify(modifier)})`, () => {
			const result = applyComposerKey(
				state("ab", 1),
				"",
				key({ return: true, ...modifier }),
			);
			expect(result).toEqual({ state: state("a\nb", 2) });
		});
	}
	test("Up/Down preserves display column through shorter logical lines", () => {
		const value = "long\n界\nlast";
		const up = applyComposerKey(
			state(value, 10),
			"",
			key({ upArrow: true }),
		).state;
		expect(up.cursorOffset).toBe(6);
		expect(
			applyComposerKey(up, "", key({ upArrow: true })).state.cursorOffset,
		).toBe(3);
		expect(
			applyComposerKey(state(value, 3), "", key({ downArrow: true })).state
				.cursorOffset,
		).toBe(6);
	});
	test("word editing preserves whole family and flag clusters", () => {
		const value = "👨‍👩‍👧‍👦 🇫🇮";
		expect(
			applyComposerKey(state(value, 3), "w", key({ ctrl: true })).state,
		).toEqual(state("👨‍👩‍👧‍👦 ", 2));
	});
});

test("Ctrl+arrow retains grapheme-safe word navigation", () => {
	const value = "👨‍👩‍👧‍👦 🇫🇮";
	expect(
		applyComposerKey(state(value, 3), "", key({ ctrl: true, leftArrow: true }))
			.state.cursorOffset,
	).toBe(2);
	expect(
		applyComposerKey(state(value, 0), "", key({ ctrl: true, rightArrow: true }))
			.state.cursorOffset,
	).toBe(1);
});

describe("composer-editor — vertical display columns", () => {
	test("CJK movement keeps the terminal column instead of grapheme count", () => {
		const up = applyComposerKey(
			state("界界\nab", 5),
			"",
			key({ upArrow: true }),
			20,
		).state;
		expect(up.cursorOffset).toBe(1);
		expect(applyComposerKey(up, "X", key({}), 20).state.value).toBe(
			"界X界\nab",
		);
	});
	test("preferred column survives short lines and resets on horizontal movement", () => {
		const value = "abcdef\nx\nabcdef";
		const up = applyComposerKey(
			state(value, 14),
			"",
			key({ upArrow: true }),
			20,
		).state;
		expect(up.cursorOffset).toBe(8);
		expect(up.preferredColumn).toBe(5);
		expect(
			applyComposerKey(up, "", key({ upArrow: true }), 20).state.cursorOffset,
		).toBe(5);
		const left = applyComposerKey(up, "", key({ leftArrow: true }), 20).state;
		expect(left.preferredColumn).toBeUndefined();
		expect(
			applyComposerKey(left, "", key({ upArrow: true }), 20).state.cursorOffset,
		).toBe(0);
	});
	test("soft-wrapped drafts navigate visual rows without explicit newlines", () => {
		const up = applyComposerKey(
			state("abcdefghij", 10),
			"",
			key({ upArrow: true }),
			4,
		).state;
		expect(up.cursorOffset).toBe(6);
		expect(
			applyComposerKey(up, "", key({ upArrow: true }), 4).state.cursorOffset,
		).toBe(2);
		expect(
			applyComposerKey(up, "", key({ downArrow: true }), 4).state.cursorOffset,
		).toBe(10);
	});
	test("tabs and joined emoji use display column boundaries", () => {
		expect(
			applyComposerKey(
				state("a\tb\n12345678", 12),
				"",
				key({ upArrow: true }),
				20,
			).state.cursorOffset,
		).toBe(2);
		expect(
			applyComposerKey(state("👨‍👩‍👧‍👦x\nab", 5), "", key({ upArrow: true }), 20)
				.state.cursorOffset,
		).toBe(1);
	});
	test("width resize recalculates visual row targets", () => {
		expect(
			applyComposerKey(state("abcdefghij", 10), "", key({ upArrow: true }), 5)
				.state.cursorOffset,
		).toBe(5);
		expect(
			applyComposerKey(state("abcdefghij", 10), "", key({ upArrow: true }), 4)
				.state.cursorOffset,
		).toBe(6);
	});
	test("single-row drafts leave arrows to history navigation", () => {
		expect(
			applyComposerKey(state("hello", 5), "", key({ upArrow: true }), 20).state,
		).toEqual(state("hello", 5));
	});
});
