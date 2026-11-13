/**
 * The one HTML escaper for text placed in markup. It has no DOM types, so
 * Workers, the CLI and scripts can import it alongside browser code.
 */

const ESCAPES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

/** HTML-escapes text for element content and attribute values. */
export function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? "");
}
