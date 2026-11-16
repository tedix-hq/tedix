/** Above this many words on either side, the whole new text counts as added. */
const MAX_WORDS = 1_500;

/**
 * The character ranges of `after` holding words that `before` did not have,
 * found by a word-level longest common subsequence. Whitespace never counts
 * as a change; neighbouring added words merge into one range.
 */
export function addedWordRanges(
	before: string,
	after: string,
): Array<[start: number, end: number]> {
	const words = (text: string) => {
		const found: Array<{ word: string; start: number; end: number }> = [];
		for (const match of text.matchAll(/\S+/g))
			found.push({
				word: match[0],
				start: match.index,
				end: match.index + match[0].length,
			});
		return found;
	};
	const old = words(before),
		next = words(after);
	if (!next.length) return [];
	if (old.length > MAX_WORDS || next.length > MAX_WORDS)
		return [[next[0]!.start, next.at(-1)!.end]];
	// lengths[i][j]: common words between old[i..] and next[j..].
	const lengths = Array.from(
		{ length: old.length + 1 },
		() => new Uint16Array(next.length + 1),
	);
	for (let i = old.length - 1; i >= 0; i--)
		for (let j = next.length - 1; j >= 0; j--)
			lengths[i]![j] =
				old[i]!.word === next[j]!.word
					? lengths[i + 1]![j + 1]! + 1
					: Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
	const ranges: Array<[number, number]> = [];
	let i = 0,
		j = 0;
	while (j < next.length) {
		if (i < old.length && old[i]!.word === next[j]!.word) {
			i++;
			j++;
		} else if (i < old.length && lengths[i + 1]![j]! >= lengths[i]![j + 1]!)
			i++;
		else {
			const { start, end } = next[j]!;
			const last = ranges.at(-1);
			// Words added side by side light up as one stretch.
			if (last && /^\s*$/.test(after.slice(last[1], start))) last[1] = end;
			else ranges.push([start, end]);
			j++;
		}
	}
	return ranges;
}
