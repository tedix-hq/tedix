const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The editor and viewport share extended grapheme cluster offsets. */
export function graphemes(value: string): string[] {
	return Array.from(segmenter.segment(value), ({ segment }) => segment);
}
