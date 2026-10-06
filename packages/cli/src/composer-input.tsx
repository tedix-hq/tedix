/**
 * Controlled, grapheme-safe multiline composer. The viewport follows the cursor
 * without truncating the draft; modified Enter inserts a newline, Enter submits,
 * and native bracketed paste keeps all pasted newlines as content.
 *
 * Burst-safety (data-loss fix): ink's App.js can split ONE stdin chunk into
 * MULTIPLE synchronous keypress events (fast typing, or a buffered/laggy
 * connection like ssh/tmux coalescing reads) and loops over ALL of them in a
 * single JS tick, invoking every active `useInput` handler once per event —
 * all BEFORE React ever re-renders. If the handler below closed over the
 * `value` prop / `cursorOffset` state directly, every event in that burst
 * would compute off the SAME stale pre-burst value (the onChange-triggered
 * state update can't flow back into the prop until the next render, which
 * doesn't happen until the burst finishes), so a burst ending in Enter would
 * submit the stale value and silently discard everything typed earlier in
 * the same burst. `pendingRef` is the fix: it's an authoritative
 * value/cursorOffset pair updated SYNCHRONOUSLY inside the handler itself,
 * so each event in a burst chains off the PREVIOUS event's result in that
 * same burst instead of off the stale rendered prop. See composer-input's
 * burst-loss regression test for a harness that reproduces ink's real
 * synchronous multi-event dispatch and proves the fix under it.
 */

import chalk from "chalk";
import {
	Box,
	Text,
	useInput,
	usePaste,
	useBoxMetrics,
	useWindowSize,
	useIsScreenReaderEnabled,
	type DOMElement,
} from "ink";
import { useLayoutEffect, useRef, useState } from "react";
import {
	applyComposerKey,
	insertComposerText,
	type ComposerKey,
	type EditorState,
} from "./composer-editor";

import { graphemes } from "./composer-graphemes";
import { composerViewport } from "./composer-viewport";

export interface ComposerInputProps {
	/** Maximum visible draft rows; scrolling follows the cursor. */
	maxRows?: number;
	/** Full measured draft row count, published synchronously during input bursts. */
	onContentRowsChange?: (totalRows: number) => void;
	/** Current input ownership, checked for each event in a synchronous burst. */
	isInputActive?: () => boolean;
	/** Current text value (controlled). */
	value: string;
	/** Placeholder shown when `value` is empty. */
	placeholder?: string;
	/** Whether the input is focused and should capture keystrokes. */
	focus?: boolean;
	/** Character to render instead of the actual value (e.g. for passwords). */
	mask?: string;
	/** Highlight pasted (multi-char) text with an inverse block cursor width. */
	highlightPastedText?: boolean;
	/** Show the fake inverse-video cursor. */
	showCursor?: boolean;
	/** Called with the next value whenever the text changes. */
	onChange: (value: string) => void;
	/** Called with the current value when Enter is pressed. */
	onSubmit?: (value: string) => void;
}

/** Grapheme-aware length (surrogate-pair / emoji safe), mirrors composer-editor.ts. */
function graphemeLength(value: string): number {
	return graphemes(value).length;
}

function ComposerInput({
	value: originalValue,
	placeholder = "",
	focus = true,
	mask,
	highlightPastedText = false,
	showCursor = true,
	maxRows = 4,
	onContentRowsChange,
	isInputActive,
	onChange,
	onSubmit,
}: ComposerInputProps) {
	const [state, setState] = useState({
		cursorOffset: graphemeLength(originalValue || ""),
		cursorWidth: 0,
	});
	const { cursorOffset, cursorWidth } = state;

	// Authoritative in-flight editor state (see the burst-safety note at the
	// top of this file). Updated synchronously inside the `useInput` handler
	// itself, so it — not the `value` prop or `cursorOffset` state — is what
	// each keystroke chains off of.
	const pendingRef = useRef<EditorState>({
		value: originalValue,
		cursorOffset: graphemeLength(originalValue || ""),
	});
	// The value we most recently pushed out via `onChange`. Lets the
	// prop-sync effect below tell an EXTERNAL value change (history recall,
	// slash-menu autocomplete, Ctrl-L clearing the input) apart from the
	// prop simply catching up to an edit we already applied to `pendingRef`
	// — only the former should overwrite `pendingRef`.
	const lastEmittedValueRef = useRef(originalValue);

	// Sync the cursor when the controlled `value` prop changes from OUTSIDE
	// (history recall, slash-menu autocomplete, clearing on submit): place the
	// cursor at the END of the replacement, readline-style. The previous
	// clamp-only behavior (ported from ink-text-input) left the cursor at its
	// OLD offset — after recalling "/runs" from an empty line the cursor sat at
	// 0, so typing PREPENDED to the recalled text and Ctrl-U (kill-to-start)
	// no-op'd. Every external
	// replacement here wants end-of-line. Also keeps `pendingRef` in lockstep
	// so the NEXT burst of keystrokes chains off the new value.
	useLayoutEffect(() => {
		const isExternalChange = originalValue !== lastEmittedValueRef.current;
		lastEmittedValueRef.current = originalValue;
		if (!isExternalChange) {
			// This is our own edit's value catching up to the prop (or a
			// render triggered by something else entirely) — `pendingRef` is
			// already authoritative (possibly further ahead, if more
			// keystrokes landed in the same burst after we last called
			// `onChange`). Don't fight it.
			return;
		}
		setState((previousState) => {
			const newLength = graphemeLength(originalValue || "");
			pendingRef.current = {
				value: originalValue,
				cursorOffset: newLength,
			};
			if (!focus || !showCursor) {
				return previousState;
			}
			return {
				cursorOffset: newLength,
				cursorWidth: 0,
			};
		});
	}, [originalValue, focus, showCursor]);

	const boxRef = useRef<DOMElement>(null);
	const { clientWidth, hasMeasured } = useBoxMetrics(boxRef);
	const { columns } = useWindowSize();
	const screenReader = useIsScreenReaderEnabled();
	const contentColumns = Math.max(1, hasMeasured ? clientWidth : columns);
	const publishedRowsRef = useRef<number | undefined>(undefined);
	const publishRows = (editor: EditorState) => {
		const rows = composerViewport(
			editor.value,
			editor.cursorOffset,
			contentColumns,
			1,
		).totalRows;
		if (rows !== publishedRowsRef.current) {
			publishedRowsRef.current = rows;
			onContentRowsChange?.(rows);
		}
	};
	useLayoutEffect(() => {
		publishRows(pendingRef.current);
	}, [originalValue, cursorOffset, contentColumns, onContentRowsChange]);
	const value = mask
		? graphemes(originalValue)
				.map((char) => (char === "\n" ? char : mask))
				.join("")
		: originalValue;
	const displayed = value || placeholder;
	const viewport = composerViewport(
		displayed,
		value ? cursorOffset : 0,
		contentColumns,
		value ? maxRows : 1,
	);
	const cursorActualWidth = highlightPastedText ? cursorWidth : 0;
	const rendered = viewport.rows
		.map((row) =>
			row
				.map(({ text, offset }) => {
					const cursor =
						showCursor &&
						focus &&
						!screenReader &&
						offset >= (value ? cursorOffset : 0) - cursorActualWidth &&
						offset <= (value ? cursorOffset : 0);
					return cursor ? chalk.inverse(text) : value ? text : chalk.grey(text);
				})
				.join(""),
		)
		.join("\n");

	usePaste(
		(text) => {
			if (isInputActive && !isInputActive()) return;
			const next = insertComposerText(pendingRef.current, text);
			pendingRef.current = next;
			publishRows(next);
			lastEmittedValueRef.current = next.value;
			setState({
				cursorOffset: next.cursorOffset,
				cursorWidth: graphemeLength(text),
			});
			onChange(next.value);
		},
		{ isActive: focus },
	);

	useInput(
		(input, key) => {
			if (isInputActive && !isInputActive()) return;
			const composerKey: ComposerKey = {
				leftArrow: key.leftArrow,
				rightArrow: key.rightArrow,
				backspace: key.backspace,
				delete: key.delete,
				return: key.return,
				home: key.home,
				end: key.end,
				ctrl: key.ctrl,
				meta: key.meta,
				upArrow: key.upArrow,
				downArrow: key.downArrow,
				tab: key.tab,
				shift: key.shift,
			};

			// Read from `pendingRef`, not the closed-over `value` prop / `cursorOffset`
			// state: within one synchronous burst of events (see the burst-safety
			// note at the top of this file) this handler's closure is stale for
			// every event after the first, but `pendingRef` chains correctly
			// because it's written synchronously below, before this function
			// returns.
			const pending = pendingRef.current;
			const result = applyComposerKey(
				pending,
				input,
				composerKey,
				contentColumns,
			);

			if (result.submit !== undefined) {
				// Reset the ref synchronously, mirroring what the parent's onSubmit
				// handler will do (clear the controlled value) once React catches
				// up. Without this, any event landing in the SAME synchronous burst
				// after the Enter (e.g. a laggy connection delivering two lines back
				// to back with no await between them, or a repeated/double Enter)
				// would chain onto the just-submitted buffer instead of starting
				// clean — corrupting the next submit or firing onSubmit twice with
				// the same value.
				pendingRef.current = { value: "", cursorOffset: 0 };
				publishRows(pendingRef.current);
				onSubmit?.(result.submit);
				return;
			}

			// A multi-char `input` arrived in a single call only for a real paste
			// (word-jump/word-delete/kill chords all pass single-letter or empty
			// `input`) — mirror ink-text-input's paste-highlight-width signal.
			const inputLength = graphemeLength(input);
			const nextCursorWidth = inputLength > 1 ? inputLength : 0;

			// Chain this event's result into the ref synchronously — before
			// `onChange`'s React state update has any chance to flow back into
			// the `value` prop — so the next event in the same burst starts from
			// this event's result.
			pendingRef.current = result.state;
			publishRows(result.state);

			setState({
				cursorOffset: result.state.cursorOffset,
				cursorWidth: nextCursorWidth,
			});

			if (result.state.value !== pending.value) {
				lastEmittedValueRef.current = result.state.value;
				onChange(result.state.value);
			}
		},
		{ isActive: focus },
	);

	return (
		<Box
			ref={boxRef}
			flexGrow={1}
			flexShrink={1}
			minWidth={1}
			flexDirection="column"
			aria-role="textbox"
			aria-state={{ multiline: true }}
			aria-label={`Message input: ${value || placeholder || "empty"}`}
		>
			<Text wrap="truncate">{rendered}</Text>
		</Box>
	);
}

export default ComposerInput;
