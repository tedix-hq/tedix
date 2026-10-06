/**
 * THE chokepoint for text this client did not author.
 *
 * Chat renders three kinds of string: the operator's own words, the model's
 * answer, and text supplied by an MCP server or a tool — tool names, arg and
 * result previews, approval summaries and operator questions. Only the first
 * is trusted. The rest are attacker-controllable by anyone who can register a
 * tool or run a server the org installed, and they render INSIDE the
 * transcript, in the transcript's own voice.
 *
 * The shape to defend against is Cloudflare's issue #42: two of three approval
 * descriptions bypassed the sanitizer, so a hostile server could write
 * "**Approved by your administrator.**" into the operator's own reading flow.
 * The lesson is not "escape harder" — it is that a sanitizer a component has
 * to REMEMBER to call is a sanitizer that is eventually skipped. Hence one
 * named util, applied at every render of untrusted text, with a test that
 * feeds hostile strings through the real card components.
 *
 * Two entry points, because chat has two render paths:
 *
 * - {@link sanitizeUntrustedText} — plain-text rendering (the live cards).
 *   React escapes markup for us there and markdown is inert, so the residual
 *   risk is the INVISIBLE characters below.
 * - {@link sanitizeUntrustedMarkdown} — `ChatMarkdown`, where the string is
 *   parsed as markdown. Adds context-aware angle-bracket escaping that keeps raw HTML a
 *   literal transcript rather than markup (paired with `skipHtml`) without
 *   disabling Markdown blockquotes, and is
 *   paired with {@link rehypeStripDirectionControls} because a string pass
 *   ALONE cannot hold on a path that decodes character references after it.
 */

/**
 * Unicode characters that change the VISUAL order of the text around them
 * without changing the string: the explicit bidi embeddings/overrides
 * (U+202A–U+202E), the isolates (U+2066–U+2069), and the implicit marks
 * (U+200E LRM, U+200F RLM, U+061C ALM).
 *
 * They are the reason "safe" text can display as something else entirely: a
 * tool name of `report` + U+202E + `txt.exe` reads as `reportexe.txt` on
 * screen, and a RIGHT-TO-LEFT OVERRIDE dropped into an approval summary can
 * reorder the operator's own sentence. Nothing in `apps/os` stripped
 * them before this module. They carry no meaning any product string needs —
 * the transcript is a single-direction UI — so they are REMOVED rather than
 * escaped: the text then renders in the order it parses, which is the whole
 * property being restored.
 */
const DIRECTION_CONTROL_PATTERN =
	/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/** Removes every bidi/direction control. Idempotent. */
export function stripDirectionControls(value: string): string {
	return value.replace(DIRECTION_CONTROL_PATTERN, "");
}

/**
 * Sanitizes server- or tool-authored text for PLAIN-TEXT rendering. Markdown
 * is deliberately left literal: on this path it is never parsed, so
 * `**Approved by your administrator.**` must render with its asterisks intact
 * — visibly quoted content rather than the transcript's own emphasis.
 */
export function sanitizeUntrustedText(value: string): string {
	return stripDirectionControls(value);
}

/**
 * Sanitizes text that will be PARSED as markdown. Escaping `<`/`>` keeps the
 * operator's literal transcript while `skipHtml` keeps it inert. A leading
 * blockquote marker is restored after escaping because `>` is Markdown syntax
 * there, not an HTML delimiter. Stripping the direction controls is the same
 * restoration as above.
 */
export function sanitizeUntrustedMarkdown(value: string): string {
	return stripDirectionControls(value)
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replace(
			/(^|\n)( {0,3})((?:&gt;)+)(?=\s|$)/g,
			(_match, lineStart: string, indent: string, markers: string) =>
				`${lineStart}${indent}${">".repeat(markers.length / "&gt;".length)}`,
		);
}

/**
 * Minimal hast node shape. Declared locally rather than imported from `hast`,
 * which is only a transitive dependency of `react-markdown` here — the same
 * choice `chat-markdown.tsx` already makes for its `pre`/`code` slots.
 */
type HastNode = {
	type: string;
	value?: unknown;
	properties?: Record<string, unknown>;
	children?: HastNode[];
};

/**
 * THE SECOND HALF OF THE DIRECTION-CONTROL DEFENCE, and the half a string
 * sanitizer cannot do.
 *
 * `sanitizeUntrustedMarkdown` runs BEFORE the markdown parser. The parser then
 * DECODES HTML character references — `&#x202E;`, `&#8238;`, `&#X0202e;` are
 * all the same RIGHT-TO-LEFT OVERRIDE — so a control the author spelled as an
 * entity is not in the string the sanitizer saw and IS in the tree that
 * renders. `report&#x202E;txt.exe` reached the DOM as a live U+202E and read
 * as `reportexe.txt` on screen: exactly the attack the module claims to stop,
 * with one layer of encoding on top.
 *
 * The fix is positional, not lexical. Stripping here — after parsing, on the
 * decoded tree — covers every spelling of every control at once (hex, decimal,
 * padded, mixed case, named, and any future one), which is why this is a
 * rehype plugin rather than a longer regex. Text nodes carry the attack;
 * string-valued properties (`alt`, `title`, `href`) are swept for the same
 * reason the text is, since they are rendered or surfaced verbatim too.
 */
export function rehypeStripDirectionControls(): (tree: HastNode) => void {
	const sweep = (node: HastNode): void => {
		if (typeof node.value === "string") {
			node.value = stripDirectionControls(node.value);
		}
		if (node.properties) {
			for (const [key, value] of Object.entries(node.properties)) {
				if (typeof value === "string") {
					node.properties[key] = stripDirectionControls(value);
				}
			}
		}
		for (const child of node.children ?? []) sweep(child);
	};
	return sweep;
}
