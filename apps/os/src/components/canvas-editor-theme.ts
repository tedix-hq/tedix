/**
 * The Canvas code editor's CodeMirror theme, expressed entirely in Tedix design tokens.
 *
 * Every colour here is a `var(--…)` from `@tedix/design-tokens`'s Kumo bridge
 * (`packages/design-tokens/src/kumo.css`), never a literal. That is not a style preference: those
 * tokens are re-declared per shell mode AND per tenant palette, so a token-valued rule follows a
 * light/dark flip and an organization's branding with no JS involved and no second palette to keep
 * in sync. The syntax colours come from the categorical `--tedix-hue-*-fg` set — the same hues the
 * rest of OS uses for work-surface categories — because code tokens are categories, not severities.
 *
 * `dark` is therefore NOT a palette switch. It is passed through to CodeMirror so its own
 * `baseTheme` dark branches (scrollbars, the default cursor blend, panel affordances) resolve
 * correctly; the palette itself is identical in both calls.
 */

import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import type { OsThemeMode } from "@/lib/theme";

// Token-valued mixes. `--color-kumo-focus` is the shell's intent accent (links, focus, selection),
// which is exactly the role a text selection plays; the alpha steps separate focused from
// unfocused without introducing a colour of their own.
const SELECTION =
	"color-mix(in srgb, var(--color-kumo-focus) 30%, transparent)";
const SELECTION_INACTIVE =
	"color-mix(in srgb, var(--color-kumo-focus) 16%, transparent)";

const highlight = HighlightStyle.define([
	{ tag: t.comment, color: "var(--text-color-kumo-inactive)" },
	{
		tag: [
			t.keyword,
			t.moduleKeyword,
			t.controlKeyword,
			t.operatorKeyword,
			t.definitionKeyword,
			t.modifier,
			t.self,
		],
		color: "var(--tedix-hue-violet-fg)",
	},
	{
		tag: [t.operator, t.punctuation, t.separator, t.bracket, t.paren, t.brace],
		color: "var(--text-color-kumo-subtle)",
	},
	{
		tag: [t.string, t.special(t.string), t.regexp, t.escape, t.attributeValue],
		color: "var(--tedix-hue-green-fg)",
	},
	{
		tag: [
			t.number,
			t.bool,
			t.null,
			t.atom,
			t.typeName,
			t.className,
			t.namespace,
			t.constant(t.variableName),
			t.attributeName,
		],
		color: "var(--tedix-hue-amber-fg)",
	},
	{
		tag: [
			t.function(t.variableName),
			t.function(t.propertyName),
			t.propertyName,
			t.standard(t.variableName),
		],
		color: "var(--tedix-hue-blue-fg)",
	},
	{
		tag: [t.variableName, t.heading],
		color: "var(--text-color-kumo-default)",
	},
	{ tag: t.tagName, color: "var(--tedix-hue-red-fg)" },
	{ tag: t.url, color: "var(--tedix-hue-teal-fg)" },
	{ tag: t.invalid, color: "var(--tedix-status-danger)" },
]);

function chrome(dark: boolean): Extension {
	return EditorView.theme(
		{
			"&": {
				color: "var(--text-color-kumo-default)",
				backgroundColor: "var(--color-kumo-base)",
				height: "100%",
				fontSize: "13px",
			},
			"&.cm-focused": { outline: "none" },
			".cm-scroller": {
				fontFamily: "var(--font-mono)",
				lineHeight: "20px",
				overflow: "auto",
			},
			".cm-content": {
				padding: "12px 0",
				caretColor: "var(--text-color-kumo-default)",
			},
			".cm-line": { padding: "0 16px 0 12px" },
			".cm-gutters": {
				backgroundColor: "var(--color-kumo-base)",
				border: "none",
				color: "var(--text-color-kumo-inactive)",
				fontSize: "12px",
			},
			".cm-lineNumbers .cm-gutterElement": {
				padding: "0 8px 0 14px",
				minWidth: "36px",
			},
			".cm-activeLine": { backgroundColor: "transparent" },
			".cm-activeLineGutter": {
				backgroundColor: "transparent",
				color: "var(--text-color-kumo-subtle)",
			},
			".cm-cursor, .cm-dropCursor": {
				borderLeftColor: "var(--text-color-kumo-default)",
			},
			"&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-content ::selection":
				{ backgroundColor: SELECTION },
			".cm-selectionBackground": { backgroundColor: SELECTION_INACTIVE },
			".cm-selectionMatch": { backgroundColor: "var(--tedix-hue-amber-tint)" },
			".cm-searchMatch": { backgroundColor: "var(--tedix-hue-amber-tint)" },
			".cm-searchMatch.cm-searchMatch-selected": {
				backgroundColor: SELECTION,
			},
			".cm-panels": {
				backgroundColor: "var(--color-kumo-elevated)",
				color: "var(--text-color-kumo-default)",
			},
			".cm-panels.cm-panels-bottom": {
				borderTop: "1px solid var(--color-kumo-line)",
			},
			".cm-panel.cm-search [name=close]": {
				color: "var(--text-color-kumo-default)",
			},
			".cm-foldGutter .cm-gutterElement": { cursor: "pointer" },
			".cm-foldPlaceholder": {
				backgroundColor: "transparent",
				border: "none",
				color: "var(--text-color-kumo-subtle)",
			},
		},
		{ dark },
	);
}

const CHROME_LIGHT = chrome(false);
const CHROME_DARK = chrome(true);
const SYNTAX = syntaxHighlighting(highlight);

/** The editor theme (chrome + syntax highlighting) for a resolved OS theme mode. */
export function canvasEditorTheme(mode: OsThemeMode): Extension {
	return [mode === "dark" ? CHROME_DARK : CHROME_LIGHT, SYNTAX];
}
