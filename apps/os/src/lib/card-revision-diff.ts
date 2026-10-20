import diff from "fast-diff";

/** Compare whole words so the review never splices letters from two drafts. */
export function cardRevisionDiff(
	before: string,
	after: string,
	granularity: "word" | "paragraph" = "word",
): [number, string][] {
	const tokens: string[] = [];
	const ids = new Map<string, string>();
	const encode = (text: string) =>
		(text.match(granularity === "word" ? /\s+|\S+/g : /[^\n]+|\n+/g) ?? [])
			.map((token) => {
				let id = ids.get(token);
				if (!id) {
					tokens.push(token);
					id = String.fromCharCode(tokens.length);
					ids.set(token, id);
				}
				return id;
			})
			.join("");
	const left = encode(before);
	const right = encode(after);
	if (tokens.length >= 0xd800)
		return [
			[-1, before],
			[1, after],
		];
	return diff(left, right).map(([kind, text]) => [
		kind,
		[...text].map((id) => tokens[id.charCodeAt(0) - 1]).join(""),
	]);
}

export interface CardRevisionHunk {
	index: number;
	unchanged: boolean;
	original: string;
	replacement: string;
}

export function cardRevisionHunks(
	before: string,
	after: string,
): CardRevisionHunk[] {
	const hunks: CardRevisionHunk[] = [];
	for (const [kind, text] of cardRevisionDiff(before, after, "paragraph")) {
		const prior = hunks.at(-1);
		if (kind !== 0 && prior && !prior.unchanged) {
			if (kind < 0) prior.original += text;
			else prior.replacement += text;
		} else
			hunks.push({
				index: hunks.length,
				unchanged: kind === 0,
				original: kind <= 0 ? text : "",
				replacement: kind >= 0 ? text : "",
			});
	}
	return hunks;
}

export function keepOriginalHunks(
	hunks: CardRevisionHunk[],
	kept: number[],
): string {
	return hunks
		.map((hunk) =>
			kept.includes(hunk.index) ? hunk.original : hunk.replacement,
		)
		.join("");
}
