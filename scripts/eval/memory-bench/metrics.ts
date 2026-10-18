export function retrieval(expected: string[], actual: string[], k = 5) {
	const relevant = new Set(expected),
		top = actual.slice(0, k);
	return {
		recall: expected.length
			? top.filter((id) => relevant.has(id)).length / expected.length
			: 0,
		mrr:
			top.findIndex((id) => relevant.has(id)) < 0
				? 0
				: 1 / (top.findIndex((id) => relevant.has(id)) + 1),
	};
}
export function percentile(values: number[], p: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0;
}
export function mean(values: number[]): number {
	return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}
