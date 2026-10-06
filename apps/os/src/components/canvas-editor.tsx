/**
 * The Canvas document editor: CodeMirror 6 bound to the room's OT edit session.
 *
 * The binding is deliberately thin, and the reason is a coincidence worth stating plainly: a
 * CodeMirror transaction's `update.changes.toJSON()` IS our `TextChange` wire format. Both sides
 * are ChangeSet's compact JSON — `@/collab/ot/code-change` is built on ChangeSet precisely because
 * @codemirror/collab is the OT substrate — so a local edit becomes a `CodeChange` by wrapping the
 * array, with no adapter, no re-diff, and no place for an offset to drift. `canvas-editor.test.tsx`
 * pins that equivalence against the real `applyCodeChange`, because it is an assumption rather than
 * a typed contract (`toJSON()` is declared `any`).
 *
 * FOUR RULES THIS FILE EXISTS TO KEEP:
 *
 * 1. `EditorState.lineSeparator.of("\n")`. CodeMirror's default splitter treats "\r" and "\r\n" as
 *    line boundaries and re-emits them as "\n", which would renumber every offset after the first
 *    such character. OT changes are offsets into the exactly-stored text, and `code-change.ts`
 *    splits on "\n" alone (`applyTextChange`), so the editor must agree or the very first edit to a
 *    CRLF document desynchronizes the replica. Stray "\r" stays visible via `highlightSpecialChars`.
 *
 * 2. Remote transactions carry the `remoteChange` annotation AND `Transaction.addToHistory.of(false)`.
 *    The annotation is what the update listener filters on, so an applied remote change is not
 *    echoed straight back to the session as a local one (an infinite round trip). The history flag
 *    keeps undo CodeMirror-native and scoped to this user's own edits: Ctrl-Z must never revert a
 *    collaborator's keystrokes.
 *
 * 3. Remote changes dispatch as explicit `{from, to, insert}` specs, never `ChangeSet.fromJSON`.
 *    A ChangeSet carries its own before-length and would be *clipped* against a document that
 *    disagrees, silently corrupting the replica; specs are position-based, so the same disagreement
 *    throws out of `dispatch` where it can be seen. A throw here means a real bug upstream.
 *
 * 4. The session object must be referentially stable for the life of an open document. Its identity
 *    is the editor's rebuild key (together with `path`) — a session rebuilt every render would tear
 *    down and re-create the view on every keystroke, losing the cursor each time.
 */

import { json } from "@codemirror/lang-json";
import {
	bracketMatching,
	foldGutter,
	foldKeymap,
	indentOnInput,
	indentUnit,
} from "@codemirror/language";
import {
	defaultKeymap,
	history,
	historyKeymap,
	indentWithTab,
} from "@codemirror/commands";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import {
	Annotation,
	Compartment,
	type ChangeSpec,
	EditorState,
	type Extension,
	Transaction,
} from "@codemirror/state";
import {
	drawSelection,
	dropCursor,
	EditorView,
	highlightSpecialChars,
	keymap,
	lineNumbers,
	rectangularSelection,
} from "@codemirror/view";
import { useEffect, useRef, useState } from "react";
import { canvasEditorTheme } from "@/components/canvas-editor-theme";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import type { CodeChange, TextChange } from "@/collab/ot/code-change";
import type { OtEditSession } from "@/collab/ot/edit-session";
import { resolveThemeMode, useOsTheme } from "@/lib/theme";

/** Marks a transaction that carries session-sourced content rather than a user keystroke. */
const remoteChange = Annotation.define<boolean>();

export type CanvasEditorBlock = ReturnType<OtEditSession["blocked"]>;

export type CanvasCodeEditorProps = {
	/** Referentially stable for the life of the open document — see rule 4 in the header. */
	session: OtEditSession;
	/** The file within the document this view edits. */
	path: string;
	readOnly?: boolean;
};

/**
 * Convert a `TextChange` (ChangeSet compact JSON) into dispatchable change specs.
 *
 * Sections tile the whole original text: a bare number retains that many code units, and
 * `[deleted, ...lines]` replaces `deleted` units with the lines joined by "\n". Exported for the
 * test that pins this against `code-change.ts`'s own application.
 */
export function specsFromTextChange(change: TextChange): ChangeSpec[] {
	const specs: ChangeSpec[] = [];
	let pos = 0;
	for (const section of change) {
		if (typeof section === "number") {
			pos += section;
			continue;
		}
		const [deleted, ...lines] = section;
		specs.push({ from: pos, to: pos + deleted, insert: lines.join("\n") });
		pos += deleted;
	}
	return specs;
}

/**
 * The local half of the binding: push locally-authored document changes into the session. The
 * session is read through `getSession` per update so the extension can be built once.
 */
export function sessionChangeListener(
	getSession: () => OtEditSession,
	path: string,
	onApplied: () => void,
): Extension {
	return EditorView.updateListener.of((update) => {
		if (!update.docChanged) return;
		// A transaction group is local only if NO transaction in it is annotated: a group mixing a
		// remote change with a local one would otherwise be attributed wholly to one side.
		if (
			update.transactions.some((tr) => tr.annotation(remoteChange) === true)
		) {
			return;
		}
		const change: CodeChange = [
			[path, { edit: update.changes.toJSON() as TextChange }],
		];
		getSession().applyLocal(change, path, update.state.doc.toString());
		onApplied();
	});
}

/**
 * The remote half of the binding: stream the session's remote changes into the view as annotated
 * transactions. `set` covers wholesale replacement (a re-seeded base, a client rebuild); `remove`
 * empties the view so stale text cannot be silently resurrected by the next keystroke. Returns an
 * unsubscriber.
 */
export function connectSessionRemote(
	view: EditorView,
	session: OtEditSession,
	path: string,
	onApplied: () => void,
): () => void {
	return session.onRemote((change) => {
		for (const [changedPath, fileChange] of change) {
			if (changedPath !== path) continue;
			if ("edit" in fileChange) {
				dispatchRemote(view, specsFromTextChange(fileChange.edit));
			} else if ("set" in fileChange) {
				if (view.state.doc.toString() !== fileChange.set) {
					replaceRemote(view, fileChange.set);
				}
			} else if (view.state.doc.length > 0) {
				replaceRemote(view, "");
			}
		}
		onApplied();
	});
}

function dispatchRemote(view: EditorView, changes: ChangeSpec[]): void {
	view.dispatch({
		changes,
		annotations: [remoteChange.of(true), Transaction.addToHistory.of(false)],
	});
}

function replaceRemote(view: EditorView, insert: string): void {
	dispatchRemote(view, [{ from: 0, to: view.state.doc.length, insert }]);
}

function sameBlock(a: CanvasEditorBlock, b: CanvasEditorBlock): boolean {
	if (a === null || b === null) return a === b;
	return a.code === b.code && a.message === b.message;
}

/** The Canvas document editor. Canvas documents are JSON, so JSON is the one language installed. */
export function CanvasCodeEditor({
	session,
	path,
	readOnly = false,
}: CanvasCodeEditorProps) {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const viewRef = useRef<EditorView | null>(null);
	const themeCompartment = useRef(new Compartment());
	const editableCompartment = useRef(new Compartment());
	const sessionRef = useRef(session);
	sessionRef.current = session;

	const { preference } = useOsTheme();
	const mode = resolveThemeMode(preference);
	const modeRef = useRef(mode);
	modeRef.current = mode;

	const [block, setBlock] = useState<CanvasEditorBlock>(null);
	// `blocked()` is a poll, not a stream, so the editor re-reads it at the two moments the client
	// can change its answer: after a local submission and after a remote row lands. Guarded by
	// value equality — a fresh object every poll would loop this component forever.
	const refreshBlock = useRef(() => {
		const next = sessionRef.current.blocked();
		setBlock((current) => (sameBlock(current, next) ? current : next));
	});

	const editable = !readOnly && block === null;
	const editableRef = useRef(editable);
	editableRef.current = editable;

	// Rebuild only on document identity: the file, or the session that owns it.
	useEffect(() => {
		const host = hostRef.current;
		if (host === null) return;

		const view = new EditorView({
			parent: host,
			state: EditorState.create({
				doc: sessionRef.current.text(path),
				extensions: [
					// Rule 1 — see the header.
					EditorState.lineSeparator.of("\n"),
					lineNumbers(),
					highlightSpecialChars(),
					history(),
					foldGutter(),
					drawSelection(),
					dropCursor(),
					EditorState.allowMultipleSelections.of(true),
					rectangularSelection(),
					indentOnInput(),
					bracketMatching(),
					highlightSelectionMatches(),
					EditorView.lineWrapping,
					indentUnit.of("  "),
					EditorState.tabSize.of(2),
					keymap.of([
						...defaultKeymap,
						...historyKeymap,
						...searchKeymap,
						...foldKeymap,
						indentWithTab,
					]),
					json(),
					themeCompartment.current.of(canvasEditorTheme(modeRef.current)),
					editableCompartment.current.of([
						EditorState.readOnly.of(!editableRef.current),
						EditorView.editable.of(editableRef.current),
					]),
					sessionChangeListener(
						() => sessionRef.current,
						path,
						() => refreshBlock.current(),
					),
				],
			}),
		});
		viewRef.current = view;
		const unsubscribe = connectSessionRemote(view, session, path, () =>
			refreshBlock.current(),
		);
		refreshBlock.current();

		return () => {
			unsubscribe();
			view.destroy();
			viewRef.current = null;
		};
	}, [session, path]);

	// Theme and editability flips reconfigure in place, keeping scroll and cursor.
	useEffect(() => {
		viewRef.current?.dispatch({
			effects: themeCompartment.current.reconfigure(canvasEditorTheme(mode)),
		});
	}, [mode]);

	useEffect(() => {
		viewRef.current?.dispatch({
			effects: editableCompartment.current.reconfigure([
				EditorState.readOnly.of(!editable),
				EditorView.editable.of(editable),
			]),
		});
	}, [editable]);

	return (
		<div className="flex h-full min-h-60 w-full flex-col gap-2">
			{block !== null && (
				<Alert variant="warning" data-testid="canvas-editor-blocked">
					<AlertTitle>Editing paused</AlertTitle>
					<AlertDescription>{block.message}</AlertDescription>
				</Alert>
			)}
			<div
				ref={hostRef}
				data-testid="canvas-editor"
				className="min-h-0 flex-1 overflow-hidden"
			/>
		</div>
	);
}
