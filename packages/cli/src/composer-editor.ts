/**
 * Pure, ink-independent composer editing logic for the tedix CLI's REPL
 * input line. Kept free of ink/React imports so the key-binding contract is
 * unit-testable in isolation (see composer-editor.test.ts).
 *
 * This module owns EVERYTHING that happens to a single keystroke once it
 * reaches the composer's own text field: character insertion, cursor
 * movement, word-level jump/delete, line-kill (Ctrl-K/Ctrl-U), and submit.
 * Keys that belong to the OUTER ink-repl.tsx useInput hook (slash-menu nav,
 * history recall, Ctrl-C/Ctrl-D/Ctrl-L) are explicit no-ops here so both
 * hooks agree on ownership without either one needing to call
 * stopPropagation (ink's input emitter has no such concept — every useInput
 * hook fires on every keystroke and self-guards).
 */

import { graphemes } from "./composer-graphemes";
import { composerViewport } from "./composer-viewport";

/** Editor state: the composer's text plus the cursor's grapheme offset into it. */
export interface EditorState {
	value: string;
	cursorOffset: number;
	/** Display column retained through consecutive vertical movements. */
	preferredColumn?: number;
}

/**
 * Minimal mirror of ink's `Key` shape — only the fields the reducer reads.
 * Deliberately structural (not imported from "ink") so this file stays
 * ink-independent; ink's `Key` is a superset and satisfies this type as-is.
 */
export interface ComposerKey {
	leftArrow: boolean;
	rightArrow: boolean;
	backspace: boolean;
	delete: boolean;
	return: boolean;
	home: boolean;
	end: boolean;
	ctrl: boolean;
	meta: boolean;
	upArrow: boolean;
	downArrow: boolean;
	tab: boolean;
	shift: boolean;
}

export interface ApplyKeyResult {
	state: EditorState;
	/** Present only on `key.return` — the value to submit. */
	submit?: string;
}

// ── Grapheme-aware string helpers ───────────────────────────────────────────
//
// Cursor offsets count extended grapheme clusters, keeping composed accents,
// emoji sequences and flags intact.

/** Clamp a grapheme offset into `[0, length]`. */
function clampOffset(offset: number, length: number): number {
	if (offset < 0) return 0;
	if (offset > length) return length;
	return offset;
}

/** Join a slice of graphemes back into a string. */
function join(chars: string[]): string {
	return chars.join("");
}

// ── Word-boundary helpers ────────────────────────────────────────────────────
//
// Native-terminal (Terminal.app/iTerm/bash) word convention: whitespace is the
// ONLY boundary. From the cursor, skip contiguous whitespace, then skip the
// contiguous run of non-whitespace beyond it — punctuation inside a token
// (e.g. "foo.bar") does NOT split the token.

/**
 * Grapheme offset of the start of the "word" ending at (or before)
 * `cursorOffset` — i.e. where Option+Backspace / Ctrl-W would stop.
 */
export function wordBoundaryBefore(
	value: string,
	cursorOffset: number,
): number {
	const chars = graphemes(value);
	let i = clampOffset(cursorOffset, chars.length);
	// Skip contiguous whitespace immediately before the cursor.
	while (i > 0 && /\s/.test(chars[i - 1] as string)) i--;
	// Skip the contiguous run of non-whitespace before that.
	while (i > 0 && !/\s/.test(chars[i - 1] as string)) i--;
	return i;
}

/**
 * Grapheme offset of the end of the "word" starting at (or after)
 * `cursorOffset` — i.e. where Option+Delete / Option+Right would stop.
 */
export function wordBoundaryAfter(value: string, cursorOffset: number): number {
	const chars = graphemes(value);
	const length = chars.length;
	let i = clampOffset(cursorOffset, length);
	// Skip contiguous whitespace immediately after the cursor.
	while (i < length && /\s/.test(chars[i] as string)) i++;
	// Skip the contiguous run of non-whitespace after that.
	while (i < length && !/\s/.test(chars[i] as string)) i++;
	return i;
}

// ── Reducer ───────────────────────────────────────────────────────────────

/**
 * Apply one ink `useInput` keystroke to composer state. Pure: no side
 * effects, never throws, always returns a valid `{ value, cursorOffset }`.
 */
export function applyComposerKey(
	state: EditorState,
	input: string,
	key: ComposerKey,
	columns = Number.MAX_SAFE_INTEGER,
): ApplyKeyResult {
	const chars = graphemes(state.value);
	const length = chars.length;
	const cursorOffset = clampOffset(state.cursorOffset, length);

	if (key.upArrow || key.downArrow) {
		const layout = composerViewport(state.value, cursorOffset, columns, 1);
		if (layout.totalRows > 1) {
			const current = layout.positions.find(
				(position) => position.offset === cursorOffset,
			)!;
			const preferredColumn = state.preferredColumn ?? current.column;
			const direction = key.upArrow ? -1 : 1;
			let row = current.row + direction;
			let target = cursorOffset;
			while (row >= 0 && row < layout.totalRows) {
				const candidates = layout.positions.filter(
					(position) => position.row === row,
				);
				if (candidates.length > 0) {
					// Floor to a visible grapheme boundary when the desired display
					// column lies within a wide glyph or expanded tab.
					const before = candidates.filter(
						(position) => position.column <= preferredColumn,
					);
					target = (before.at(-1) ?? candidates[0])!.offset;
					break;
				}
				// An expanded tab may occupy a row with no editable boundary.
				row += direction;
			}
			return {
				state: { value: state.value, cursorOffset: target, preferredColumn },
			};
		}
	}

	// Keys owned by the OUTER ink-repl.tsx useInput hook (slash-menu nav,
	// history recall, Ctrl-C, Ctrl-D quit, Ctrl-L clear-screen) — no-op here so
	// neither hook double-handles nor a stray letter leaks into the text.
	if (
		key.upArrow ||
		key.downArrow ||
		key.tab ||
		(key.shift && key.tab) ||
		(key.ctrl && input === "c") ||
		(key.ctrl && input === "d") ||
		(key.ctrl && input === "l")
	) {
		return { state: { value: state.value, cursorOffset } };
	}

	// Modified Enter is an explicit newline; plain Enter keeps submit semantics.
	if (
		(key.return || input === "\r" || input === "\n") &&
		(key.shift || key.meta)
	) {
		return {
			state: insertComposerText({ value: state.value, cursorOffset }, "\n"),
		};
	}

	// Some PTYs deliver an editing control plus following text as a single
	// unclassified chunk (for example Ctrl-U followed by a paste). Ink does not
	// set `key.ctrl` in that shape, so replay the two kill controls here instead
	// of inserting their C0 bytes into the composer. A final Enter retains the
	// normal coalesced text+submit contract below.
	if (
		!key.ctrl &&
		!key.meta &&
		(input.includes("\u0015") || input.includes("\u000b"))
	) {
		const trailingTerminator = input.endsWith("\r") || input.endsWith("\n");
		const content = trailingTerminator ? input.slice(0, -1) : input;
		let nextValue = state.value;
		let nextCursorOffset = cursorOffset;
		for (const char of content) {
			const current = graphemes(nextValue);
			if (char === "\u0015") {
				nextValue = join(current.slice(nextCursorOffset));
				nextCursorOffset = 0;
			} else if (char === "\u000b") {
				nextValue = join(current.slice(0, nextCursorOffset));
			} else {
				const inserted = insertComposerText(
					{ value: nextValue, cursorOffset: nextCursorOffset },
					char,
				);
				nextValue = inserted.value;
				nextCursorOffset = inserted.cursorOffset;
			}
		}
		const nextState = { value: nextValue, cursorOffset: nextCursorOffset };
		return trailingTerminator
			? { state: nextState, submit: nextValue }
			: { state: nextState };
	}

	// Ink keeps CR/LF attached to a preceding plain-text run when both arrive in
	// one stdin chunk. Real PTYs, automation, SSH, and tmux can coalesce exactly
	// that text+Enter pair (live repro: "/sessions\r" rendered a literal CR and
	// waited for another Enter). Treat ONE trailing terminator as submit while
	// preserving the printable prefix as the final edit. Embedded/multiple
	// newlines remain paste content and are not executed as multiple commands.
	const trailingTerminator = input.endsWith("\r") || input.endsWith("\n");
	const inputBeforeTerminator = trailingTerminator ? input.slice(0, -1) : input;
	if (
		trailingTerminator &&
		!inputBeforeTerminator.includes("\r") &&
		!inputBeforeTerminator.includes("\n")
	) {
		const inserted = graphemes(inputBeforeTerminator);
		const nextValue = join([
			...chars.slice(0, cursorOffset),
			...inserted,
			...chars.slice(cursorOffset),
		]);
		const nextState = {
			value: nextValue,
			cursorOffset: graphemes(
				join(chars.slice(0, cursorOffset)) + inputBeforeTerminator,
			).length,
		};
		return { state: nextState, submit: nextValue };
	}

	if (key.return) {
		return { state: { value: state.value, cursorOffset }, submit: state.value };
	}

	// Ctrl-J (raw LF, 0x0A) is a parser quirk in ink's non-kitty legacy path:
	// parseKeypress special-cases '\n' as name:"enter" WITHOUT setting
	// key.ctrl, and use-input.js only clears `input` / sets `key.return` for
	// name:"return" (Ctrl-M / plain Enter) — so a bare Ctrl-J arrives here as
	// `key = {ctrl:false, meta:false, ...}` with `input === "\n"`, which would
	// otherwise fall through the ctrl/meta guard below and splice a raw
	// newline into the single-line buffer. Treat it as submit (the behavior
	// ink's own "enter" naming implies, and the classic canonical-terminal
	// meaning of LF) rather than corrupting the value or silently eating it.
	// ── Word jump: Option+Left/Right, or the ESC+letter emacs form (b/f). ────
	if (
		(key.meta && (key.leftArrow || input === "b")) ||
		(key.ctrl && key.leftArrow)
	) {
		return {
			state: {
				value: state.value,
				cursorOffset: wordBoundaryBefore(state.value, cursorOffset),
			},
		};
	}
	if (
		(key.meta && (key.rightArrow || input === "f")) ||
		(key.ctrl && key.rightArrow)
	) {
		return {
			state: {
				value: state.value,
				cursorOffset: wordBoundaryAfter(state.value, cursorOffset),
			},
		};
	}

	// ── Word delete: Option+Backspace/Delete, and Ctrl-W (unix-word-rubout). ─
	if ((key.meta && key.backspace) || (key.ctrl && input === "w")) {
		const start = wordBoundaryBefore(state.value, cursorOffset);
		const nextValue = join([
			...chars.slice(0, start),
			...chars.slice(cursorOffset),
		]);
		return { state: { value: nextValue, cursorOffset: start } };
	}
	if (key.meta && key.delete) {
		const end = wordBoundaryAfter(state.value, cursorOffset);
		const nextValue = join([
			...chars.slice(0, cursorOffset),
			...chars.slice(end),
		]);
		return { state: { value: nextValue, cursorOffset } };
	}

	// ── Home/End, incl. Ctrl-A / Ctrl-E (readline convention). ──────────────
	if (key.home || (key.ctrl && input === "a")) {
		return { state: { value: state.value, cursorOffset: 0 } };
	}
	if (key.end || (key.ctrl && input === "e")) {
		return { state: { value: state.value, cursorOffset: length } };
	}

	// ── Kill-to-end / kill-to-start (Ctrl-K / Ctrl-U). ───────────────────────
	if (key.ctrl && input === "k") {
		const nextValue = join(chars.slice(0, cursorOffset));
		return { state: { value: nextValue, cursorOffset } };
	}
	if (key.ctrl && input === "u") {
		const nextValue = join(chars.slice(cursorOffset));
		return { state: { value: nextValue, cursorOffset: 0 } };
	}

	// ── Plain arrow movement (no meta). ──────────────────────────────────────
	if (key.leftArrow) {
		return {
			state: {
				value: state.value,
				cursorOffset: clampOffset(cursorOffset - 1, length),
			},
		};
	}
	if (key.rightArrow) {
		return {
			state: {
				value: state.value,
				cursorOffset: clampOffset(cursorOffset + 1, length),
			},
		};
	}

	// ── Plain single-char delete (no meta), grapheme-aware. ────────────────
	if (key.backspace) {
		if (cursorOffset === 0)
			return { state: { value: state.value, cursorOffset } };
		const nextValue = join([
			...chars.slice(0, cursorOffset - 1),
			...chars.slice(cursorOffset),
		]);
		return { state: { value: nextValue, cursorOffset: cursorOffset - 1 } };
	}
	if (key.delete) {
		if (cursorOffset >= length)
			return { state: { value: state.value, cursorOffset } };
		const nextValue = join([
			...chars.slice(0, cursorOffset),
			...chars.slice(cursorOffset + 1),
		]);
		return { state: { value: nextValue, cursorOffset } };
	}

	// ── Any other ctrl/meta chord not explicitly bound above → safely ignore.
	// This is the core fix: an unbound control chord must never fall through
	// to the plain-insert branch and echo its letter into the text.
	if (key.ctrl || key.meta) {
		return { state: { value: state.value, cursorOffset } };
	}

	// Plain input, including legacy multiline paste. Bracketed paste uses the
	// separate insertComposerText entry point and never passes submit detection.
	if (input.length > 0) {
		return {
			state: insertComposerText({ value: state.value, cursorOffset }, input),
		};
	}

	// No recognized key and no input text (e.g. a bare modifier or an escape
	// sequence ink didn't resolve to any of the above) → no-op.
	return { state: { value: state.value, cursorOffset } };
}

/** Insert text without interpreting controls or a trailing newline as submit. */
export function insertComposerText(
	state: EditorState,
	input: string,
): EditorState {
	const chars = graphemes(state.value);
	const cursor = clampOffset(state.cursorOffset, chars.length);
	const prefix = join(chars.slice(0, cursor)) + input.replace(/\r\n?/g, "\n");
	const value = prefix + join(chars.slice(cursor));
	return {
		value,
		cursorOffset: Math.min(graphemes(prefix).length, graphemes(value).length),
	};
}
