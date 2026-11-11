/**
 * The editor for one file of a workspace app: line numbers, folding, syntax
 * colours by file type, search, and undo. It edits plain text it is handed;
 * the collaborative manifest editor is `canvas-editor.tsx`.
 *
 * Loaded on demand (see `app-code-editor-lazy.tsx`), and each language is
 * fetched only when a file of that type is opened.
 */

import {
	defaultKeymap,
	history,
	historyKeymap,
	indentWithTab,
} from "@codemirror/commands";
import {
	bracketMatching,
	foldGutter,
	foldKeymap,
	indentOnInput,
	indentUnit,
} from "@codemirror/language";
import {
	highlightSelectionMatches,
	search,
	searchKeymap,
} from "@codemirror/search";
import {
	Compartment,
	EditorState,
	type Extension,
	Prec,
} from "@codemirror/state";
import {
	drawSelection,
	dropCursor,
	EditorView,
	highlightActiveLine,
	highlightActiveLineGutter,
	highlightSpecialChars,
	keymap,
	lineNumbers,
	rectangularSelection,
} from "@codemirror/view";
import { useEffect, useRef } from "react";
import { canvasEditorTheme } from "@/components/canvas-editor-theme";
import { resolveThemeMode, useOsTheme } from "@/lib/theme";

/** The syntax for a file, chosen by its extension; plain text when unknown. */
export async function appCodeLanguage(path: string): Promise<Extension> {
	const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
	switch (extension) {
		case "js":
		case "mjs":
		case "cjs":
		case "jsx":
			return (await import("@codemirror/lang-javascript")).javascript({
				jsx: extension === "jsx",
			});
		case "ts":
		case "tsx":
			return (await import("@codemirror/lang-javascript")).javascript({
				typescript: true,
				jsx: extension === "tsx",
			});
		case "json":
			return (await import("@codemirror/lang-json")).json();
		case "md":
		case "markdown":
			return (await import("@codemirror/lang-markdown")).markdown();
		default:
			return [];
	}
}

// The file sits directly on the pane, so the editor paints no surface of its
// own; the open line and the search bar are the only chrome it adds.
const ACTIVE_LINE =
	"color-mix(in srgb, var(--color-kumo-tint) 55%, transparent)";
const paneChrome = Prec.highest(
	EditorView.theme({
		"&": { backgroundColor: "transparent" },
		".cm-gutters": { backgroundColor: "transparent" },
		".cm-activeLine": { backgroundColor: ACTIVE_LINE },
		".cm-activeLineGutter": {
			backgroundColor: ACTIVE_LINE,
			color: "var(--text-color-kumo-default)",
		},
		"&:not(.cm-focused) .cm-activeLine, &:not(.cm-focused) .cm-activeLineGutter":
			{ backgroundColor: "transparent" },
		".cm-matchingBracket, .cm-nonmatchingBracket": {
			backgroundColor: "transparent",
			outline: "1px solid var(--color-kumo-line)",
			borderRadius: "2px",
		},
		".cm-panels.cm-panels-top": {
			borderBottom: "1px solid var(--color-kumo-line)",
		},
		".cm-panel.cm-search": {
			display: "flex",
			flexWrap: "wrap",
			alignItems: "center",
			gap: "6px",
			padding: "6px 32px 6px 12px",
			fontFamily: "var(--font-sans, inherit)",
			fontSize: "12px",
		},
		".cm-panel.cm-search br": { display: "none" },
		".cm-panel.cm-search label": {
			display: "inline-flex",
			alignItems: "center",
			gap: "4px",
			color: "var(--text-color-kumo-subtle)",
		},
		".cm-textfield": {
			height: "26px",
			margin: "0",
			padding: "0 8px",
			border: "1px solid var(--color-kumo-line)",
			borderRadius: "6px",
			backgroundColor: "var(--color-kumo-base)",
			color: "var(--text-color-kumo-default)",
			fontSize: "12px",
		},
		".cm-textfield:focus-visible": {
			outline: "2px solid var(--color-kumo-focus)",
			outlineOffset: "-1px",
		},
		".cm-button": {
			height: "26px",
			margin: "0",
			padding: "0 8px",
			border: "1px solid var(--color-kumo-line)",
			borderRadius: "6px",
			backgroundImage: "none",
			backgroundColor: "var(--color-kumo-control)",
			color: "var(--text-color-kumo-default)",
			fontSize: "12px",
			textTransform: "capitalize",
		},
		".cm-panel.cm-search [name=close]": {
			top: "6px",
			right: "8px",
			width: "22px",
			height: "22px",
			fontSize: "16px",
			cursor: "pointer",
		},
	}),
);

export type AppCodeEditorProps = {
	/** The open file; its extension picks the syntax. */
	path: string;
	value: string;
	onChange?: (value: string) => void;
	readOnly?: boolean;
};

export default function AppCodeEditor({
	path,
	value,
	onChange,
	readOnly = false,
}: AppCodeEditorProps) {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const viewRef = useRef<EditorView | null>(null);
	const themeCompartment = useRef(new Compartment());
	const editableCompartment = useRef(new Compartment());
	const languageCompartment = useRef(new Compartment());
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	const valueRef = useRef(value);
	valueRef.current = value;
	const readOnlyRef = useRef(readOnly);
	readOnlyRef.current = readOnly;

	const { preference } = useOsTheme();
	const mode = resolveThemeMode(preference);
	const modeRef = useRef(mode);
	modeRef.current = mode;

	// One view per open file, so each file starts with its own undo history.
	useEffect(() => {
		const host = hostRef.current;
		if (host === null) return;
		const view = new EditorView({
			parent: host,
			state: EditorState.create({
				doc: valueRef.current,
				extensions: [
					// Keep "\r" as text, so what is saved is exactly what was loaded.
					EditorState.lineSeparator.of("\n"),
					lineNumbers(),
					highlightActiveLineGutter(),
					highlightSpecialChars(),
					history(),
					foldGutter(),
					drawSelection(),
					dropCursor(),
					EditorState.allowMultipleSelections.of(true),
					rectangularSelection(),
					indentOnInput(),
					bracketMatching(),
					highlightActiveLine(),
					highlightSelectionMatches(),
					search({ top: true }),
					indentUnit.of("  "),
					EditorState.tabSize.of(2),
					keymap.of([
						...defaultKeymap,
						...historyKeymap,
						...searchKeymap,
						...foldKeymap,
						indentWithTab,
					]),
					languageCompartment.current.of([]),
					themeCompartment.current.of(canvasEditorTheme(modeRef.current)),
					paneChrome,
					editableCompartment.current.of([
						EditorState.readOnly.of(readOnlyRef.current),
						EditorView.editable.of(!readOnlyRef.current),
					]),
					EditorView.contentAttributes.of({
						"aria-label": `${readOnlyRef.current ? "Contents of" : "Edit"} ${path}`,
					}),
					EditorView.updateListener.of((update) => {
						if (!update.docChanged) return;
						const next = update.state.doc.toString();
						if (next === valueRef.current) return;
						valueRef.current = next;
						onChangeRef.current?.(next);
					}),
				],
			}),
		});
		viewRef.current = view;
		let open = true;
		void appCodeLanguage(path).then((language) => {
			if (open)
				view.dispatch({
					effects: languageCompartment.current.reconfigure(language),
				});
		});
		return () => {
			open = false;
			view.destroy();
			viewRef.current = null;
		};
	}, [path]);

	// Text replaced from outside (a reload, a reset) lands without a rebuild.
	useEffect(() => {
		const view = viewRef.current;
		if (!view || view.state.doc.toString() === value) return;
		view.dispatch({
			changes: { from: 0, to: view.state.doc.length, insert: value },
		});
	}, [value]);

	useEffect(() => {
		viewRef.current?.dispatch({
			effects: themeCompartment.current.reconfigure(canvasEditorTheme(mode)),
		});
	}, [mode]);

	useEffect(() => {
		viewRef.current?.dispatch({
			effects: editableCompartment.current.reconfigure([
				EditorState.readOnly.of(readOnly),
				EditorView.editable.of(!readOnly),
			]),
		});
	}, [readOnly]);

	return (
		<div
			ref={hostRef}
			className="app-code-editor"
			data-app-code-editor={path}
		/>
	);
}
