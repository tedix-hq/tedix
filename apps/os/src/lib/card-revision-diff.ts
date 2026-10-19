import diff from "fast-diff";

/** Compare whole words so the review never splices letters from two drafts. */
export function cardRevisionDiff(
	before: string,
	after: string,
): [number, string][] {
	const tokens: string[] = [];
	const ids = new Map<string, string>();
	const encode = (text: string) =>
		(text.match(/\s+|\S+/g) ?? [])
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
