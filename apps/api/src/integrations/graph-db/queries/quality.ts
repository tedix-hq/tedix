export const MIN_EXPLANATION_FACT_CONFIDENCE = 0.3;
export const MIN_EXPLANATION_EDGE_STRENGTH = 0.2;

/** Clamp values interpolated into Cypher range syntax to a safe integer. */
export function boundedGraphInteger(
	value: number,
	fallback: number,
	maximum: number,
): number {
	const finite = Number.isFinite(value) ? Math.trunc(value) : fallback;
	return Math.max(1, Math.min(maximum, finite));
}
