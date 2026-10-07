/**
 * One line of agent Markdown as plain text, for titles such as a
 * decision-capture Interaction subject: block markers, emphasis, code ticks and
 * link syntax go, code-span text stays verbatim, whitespace collapses. Shared
 * by the CLI (new subjects) and Tedix OS (rows written before the CLI did it).
 */
export function markdownLineToPlainText(line: string): string {
	const leading =
		/^(?:#{1,6}(?=\s|$)|>|[-*+](?=\s)|\d{1,3}[.)](?=\s)|\[[ xX]\](?=\s))\s*/;
	let text = line.replace(/\s+/g, " ").trim();
	while (leading.test(text)) text = text.replace(leading, "");
	// Code spans keep their text verbatim; emphasis is only stripped outside them.
	return text
		.replace(/\s+#+$/, "")
		.split(/(`+[^`]*`+)/)
		.map((part, index) =>
			index % 2
				? part.replace(/`+/g, "")
				: part
						.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
						.replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
						.replace(/(^|\W)__(?=\S)(.*?\S)__(?=\W|$)/g, "$1$2")
						.replace(/\*\*|~~|`+/g, "")
						.replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?=[^\w*]|$)/g, "$1$2")
						.replace(/(^|\W)_(?=\S)([^_]*?\S)_(?=\W|$)/g, "$1$2"),
		)
		.join("")
		.replace(/^[\s*_#>-]+|[\s*_#>-]+$/g, "")
		.replace(/\s+/g, " ")
		.trim();
}
