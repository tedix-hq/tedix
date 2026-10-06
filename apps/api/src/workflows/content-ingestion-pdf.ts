/**
 * Pure shaping for `env.AI.toMarkdown` PDF output, split out of
 * `content-ingestion.ts` so it is testable without `cloudflare:workers`.
 *
 * `toMarkdown` emits a document head before the extracted text:
 *
 *     # <file name>
 *     ## Metadata
 *     - Title=...
 *     - Producer=...
 *     ## Contents
 *     ### Page 1
 *     ...
 *
 * The head carries the only copy of the PDF's own title, and the rest of it is
 * PDFFormatVersion/Producer/xmp noise that would otherwise be written to R2 and
 * indexed as body text. So it is parsed for the title, then dropped.
 */

const PDF_CONTENTS_MARKER = "\n## Contents\n";

export function splitConvertedPdf(
	markdown: string,
	url: string,
): { title: string; body: string } {
	const marker = markdown.indexOf(PDF_CONTENTS_MARKER);
	const head = marker === -1 ? "" : markdown.slice(0, marker);
	const body =
		marker === -1
			? markdown
			: markdown.slice(marker + PDF_CONTENTS_MARKER.length);

	const titleLine = /^- Title=(.*)$/m.exec(head);
	const title =
		titleLine?.[1]?.trim() || url.split("/").pop() || "PDF Document";

	return { title, body };
}
