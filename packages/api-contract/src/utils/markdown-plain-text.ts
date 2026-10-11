/**
 * One line of agent Markdown as plain text, for titles such as a
 * decision-capture Interaction subject: block markers, emphasis, code ticks and
 * link syntax go, code-span text stays verbatim, whitespace collapses. Shared
 * by the CLI (new subjects) and Tedix OS (rows written before the CLI did it).
 *
 * The input is agent-written, so link and autolink syntax is removed by
 * single-pass scans rather than regexes whose unbounded classes backtrack
 * quadratically on text such as a long run of `[` without a closing `]`.
 */
export function markdownLineToPlainText(line: string): string {
	const leading =
		// `text` is already whitespace-collapsed and trimmed, so a single space
		// is the only separator left; no `\s` class, nothing to backtrack over.
		/^(?:#{1,6}(?= |$)|>|[-*+](?= )|\d{1,3}[.)](?= )|\[[ xX]\](?= )) ?/;
	let text = line.replace(/\s+/g, " ").trim();
	while (leading.test(text)) text = text.replace(leading, "");
	// Code spans keep their text verbatim; emphasis is only stripped outside them.
	return text
		.replace(/ #+$/, "")
		.split(/(`+[^`]*`+)/)
		.map((part, index) =>
			index % 2
				? part.replace(/`+/g, "")
				: stripAutolinks(stripLinks(part))
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

/** `[text](target)` and `![alt](target)` become `text`; the same matches as `/!?\[([^\]]*)\]\([^)]*\)/g`, found in one pass. */
function stripLinks(text: string): string {
	let out = "";
	let from = 0;
	for (;;) {
		const open = text.indexOf("[", from);
		if (open < 0) break;
		const close = text.indexOf("]", open + 1);
		if (close < 0) break;
		if (text[close + 1] !== "(") {
			// No `[` before this `]` can start a link either.
			out += text.slice(from, close + 1);
			from = close + 1;
			continue;
		}
		const end = text.indexOf(")", close + 2);
		if (end < 0) break;
		const start = open > from && text[open - 1] === "!" ? open - 1 : open;
		out += text.slice(from, start) + text.slice(open + 1, close);
		from = end + 1;
	}
	return out + text.slice(from);
}

/** `<https://…>` loses its angle brackets; the same matches as `/<(https?:\/\/[^>\s]+)>/g`, found in one pass. */
function stripAutolinks(text: string): string {
	let out = "";
	let from = 0;
	for (;;) {
		const open = text.indexOf("<http", from);
		if (open < 0) break;
		const scheme = text.startsWith("<https://", open)
			? 9
			: text.startsWith("<http://", open)
				? 8
				: 0;
		if (!scheme) {
			out += text.slice(from, open + 1);
			from = open + 1;
			continue;
		}
		let end = open + scheme;
		while (end < text.length && text[end] !== ">" && !/\s/.test(text[end]!))
			end += 1;
		if (end === open + scheme || text[end] !== ">") {
			// Every `<http` up to here runs into the same whitespace or line end.
			out += text.slice(from, end);
			from = end;
			continue;
		}
		out += text.slice(from, open) + text.slice(open + 1, end);
		from = end + 1;
	}
	return out + text.slice(from);
}
