/** Keep the changed passage when the surrounding draft exceeds the ledger budget. */
export function decisionEditContext(before: string, after: string) {
	let start = 0;
	while (
		start < Math.min(before.length, after.length) &&
		before[start] === after[start]
	)
		start++;
	const offset = Math.max(0, start - 120);
	return {
		before: before.slice(offset, offset + 1000),
		after: after.slice(offset, offset + 1000),
		offset,
		originalLength: before.length,
		editedLength: after.length,
	};
}
