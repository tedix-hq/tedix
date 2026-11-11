/**
 * Small line icons for the Doc, Sheet and Slides toolbars. The editors run
 * in a sandbox without the OS icon set, so each icon is one inline path on a
 * 16px grid that takes the text colour.
 */
const PATHS = {
	alignLeft: "M2.5 4h11M2.5 8h7M2.5 12h9",
	alignCenter: "M2.5 4h11M4.5 8h7M3.5 12h9",
	alignRight: "M2.5 4h11M6.5 8h7M4.5 12h9",
	undo: "M5.5 3.5 2.5 6.5l3 3M2.5 6.5H9a3.5 3.5 0 0 1 0 7H6",
	redo: "M10.5 3.5l3 3-3 3M13.5 6.5H7a3.5 3.5 0 0 0 0 7h3",
	wrap: "M2.5 4h11M2.5 8H11a2 2 0 0 1 0 4H9l1.5-1.5M9 12l1.5 1.5M2.5 12H6",
	eraser: "M6.5 13.5h7M3 10.5 9.5 4 13 7.5 7.5 13h-2z",
	addRow: "M2.5 3.5h11v5h-11zM8 10.5v4M6 12.5h4",
	addColumn: "M3.5 2.5h5v11h-5zM10.5 8h4M12.5 6v4",
	fillDown: "M8 2.5v9M4.5 8 8 11.5 11.5 8M3 13.5h10",
	fillRight: "M2.5 8h9M8 4.5 11.5 8 8 11.5M13.5 3v10",
	sortUp: "M4.5 13V3M2.5 5l2-2 2 2M9 4h1.5M9 8h3M9 12h4.5",
	sortDown: "M4.5 3v10M2.5 11l2 2 2-2M9 4h4.5M9 8h3M9 12h1.5",
	clear: "M3 3h10v10H3zM6 6l4 4M10 6l-4 4",
	plus: "M8 3v10M3 8h10",
	copy: "M5.5 5.5h7v7h-7zM3.5 10.5v-7h7",
	trash: "M3 4.5h10M6.5 4.5v-2h3v2M4.5 4.5l.5 9h6l.5-9",
	image: "M2.5 3.5h11v9h-11zM2.5 10.5l3-3 2.5 2.5 2-2 3.5 3.5M10.5 6.5h.01",
	up: "M8 13V3M4.5 6.5 8 3l3.5 3.5",
	down: "M8 3v10M4.5 9.5 8 13l3.5-3.5",
	back: "M5.5 2.5h8v8h-8zM2.5 5.5v8h8",
	front: "M2.5 2.5h8v8h-8zM13.5 5.5v8h-8",
	play: "M5 3.5v9l7.5-4.5z",
	reload: "M13 8a5 5 0 1 1-1.5-3.5M13 3v2.5h-2.5",
	download: "M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10",
	bold: "M4.5 3h4a2.5 2.5 0 0 1 0 5h-4zM4.5 8h4.8a2.5 2.5 0 0 1 0 5H4.5z",
	italic: "M6.5 3h5M4.5 13h5M9.5 3l-3 10",
	underline: "M4.5 3v4.5a3.5 3.5 0 0 0 7 0V3M3.5 13.5h9",
	strike:
		"M2.5 8h11M11 5.2C11 3.9 9.8 3 8 3S5 3.9 5 5.2M5 10.8C5 12.1 6.2 13 8 13s3-.9 3-2.2",
	code: "M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5",
	bullets: "M6 4h7.5M6 8h7.5M6 12h7.5M2.8 4h.01M2.8 8h.01M2.8 12h.01",
	numbers: "M7 4h6.5M7 8h6.5M7 12h6.5M2.5 3.5l1-.5v3M2.5 10h1.5L2.5 12.5H4",
	todo: "M2.5 2.5h11v11h-11zM5 8l2.2 2.2L11 6",
	link: "M6.8 9.2a2.8 2.8 0 0 0 4 0l2-2a2.8 2.8 0 0 0-4-4l-.7.7M9.2 6.8a2.8 2.8 0 0 0-4 0l-2 2a2.8 2.8 0 0 0 4 4l.7-.7",
	table: "M2.5 3.5h11v9h-11zM2.5 6.5h11M6.5 3.5v9",
	more: "M3 8a.6.6 0 1 0 1.2 0 .6.6 0 1 0-1.2 0M7.4 8a.6.6 0 1 0 1.2 0 .6.6 0 1 0-1.2 0M11.8 8a.6.6 0 1 0 1.2 0 .6.6 0 1 0-1.2 0",
	alignJustify: "M2.5 4h11M2.5 8h11M2.5 12h11",
} as const;

export type EditorIcon = keyof typeof PATHS;

export function editorIcon(name: EditorIcon): string {
	return `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${PATHS[name]}"/></svg>`;
}

/** An icon button that still has a name for tooltips and screen readers. */
export function iconButton(
	attrs: string,
	label: string,
	name: EditorIcon,
): string {
	return `<button ${attrs} class="icon" title="${label}" aria-label="${label}">${editorIcon(name)}</button>`;
}

/** Styles shared by the three editors' icon buttons and dividers. */
export const EDITOR_ICON_CSS = `button.icon{display:inline-grid;place-items:center;min-width:28px;height:28px;padding:0;border-color:transparent;background:transparent}button.icon:hover:not(:disabled){background:color-mix(in srgb,var(--tedix-fg,CanvasText) 8%,transparent)}button.primary{background:var(--tedix-primary,Highlight);border-color:transparent;color:var(--tedix-on-primary,HighlightText)}.bar-divider{width:1px;height:18px;margin:0 4px;background:var(--tedix-border,color-mix(in srgb,CanvasText 18%,transparent));flex:none}@media(pointer:coarse){button.icon{min-width:44px;height:44px}}`;
