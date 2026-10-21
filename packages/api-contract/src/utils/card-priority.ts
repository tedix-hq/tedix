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

const WHY_FEATURES = 2;

function featureName(value: unknown): string {
	return typeof value === "string"
		? value
				.replace(/([a-z])([A-Z])/g, "$1 $2")
				.replace(/[_-]+/g, " ")
				.replace(/\s+/g, " ")
				.trim()
				.toLowerCase()
				.slice(0, 40)
		: "";
}

function featureWeight(value: unknown): number {
	if (typeof value === "number") return Number.isFinite(value) ? value : 0;
	return value === true ? 1 : 0;
}

/** Named feature weights from a factory's `features` cell, in either list or map form. */
function featureEntries(features: unknown): [string, number][] {
	if (Array.isArray(features))
		return features.map((item): [string, number] => {
			if (typeof item === "string") return [featureName(item), 1];
			if (!item || typeof item !== "object") return ["", 0];
			const entry = item as Record<string, unknown>;
			const weight = entry.contribution ?? entry.weight ?? entry.value;
			return [
				featureName(entry.label ?? entry.name ?? entry.key),
				weight === undefined ? 1 : featureWeight(weight),
			];
		});
	if (features && typeof features === "object")
		return Object.entries(features).map(([name, weight]) => [
			featureName(name),
			featureWeight(weight),
		]);
	return [];
}

/** One plain line naming the features that most raised a factory card, or null. */
export function whyThisCard(features: unknown): string | null {
	const names = featureEntries(features)
		.filter(([name, weight]) => name && weight > 0)
		.sort((a, b) => b[1] - a[1])
		.slice(0, WHY_FEATURES)
		.map(([name]) => name);
	if (names.length === 0) return null;
	return `Why this card: ${names.join(", ")}`;
}
