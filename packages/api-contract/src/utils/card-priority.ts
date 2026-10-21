/** A factory's own 0–1 priority for a card; undefined when it supplied none or an invalid one. */
export function factoryCardScore(card: {
	score?: unknown;
}): number | undefined {
	const { score } = card;
	return typeof score === "number" &&
		Number.isFinite(score) &&
		score >= 0 &&
		score <= 1
		? score
		: undefined;
}

/**
 * Factory score after critical classes: a scored card leads unscored ones,
 * higher scores first; two unscored cards tie so the caller's order decides.
 */
export function compareFactoryScore(
	a: { score?: unknown } | undefined,
	b: { score?: unknown } | undefined,
): number {
	const left = a ? factoryCardScore(a) : undefined;
	const right = b ? factoryCardScore(b) : undefined;
	if (left === undefined || right === undefined)
		return Number(right !== undefined) - Number(left !== undefined);
	return right - left;
}
