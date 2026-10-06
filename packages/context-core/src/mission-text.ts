export const DEFAULT_MISSION_STOP_WORDS = [
	"a",
	"an",
	"and",
	"are",
	"be",
	"do",
	"for",
	"from",
	"help",
	"how",
	"i",
	"in",
	"is",
	"it",
	"me",
	"my",
	"of",
	"on",
	"or",
	"please",
	"that",
	"the",
	"this",
	"to",
	"ur",
	"us",
	"we",
	"what",
	"with",
	"you",
];

export function normalizeMissionText(input: string): string {
	return input
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function tokenizeMissionText(
	input: string,
	stopWords?: Set<string>,
): string[] {
	const words = stopWords ?? new Set(DEFAULT_MISSION_STOP_WORDS);
	return normalizeMissionText(input)
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.split(/\s+/)
		.filter((token) => token && token.length > 2 && !words.has(token));
}

export function scoreMissionTextOverlap(
	a: string,
	b: string,
	stopWords?: Set<string>,
): number {
	const left = new Set(tokenizeMissionText(a, stopWords));
	const right = new Set(tokenizeMissionText(b, stopWords));
	if (left.size === 0 || right.size === 0) return 0;
	let overlap = 0;
	for (const token of left) {
		if (right.has(token)) overlap += 1;
	}
	return overlap / Math.max(left.size, right.size);
}

export function summarizeMissionText(message: string, maxLength = 120): string {
	const normalized = normalizeMissionText(message)
		.replace(/^[-*#\s]+/, "")
		.replace(/^["'`]+|["'`]+$/g, "");
	const sentence = normalized.split(/[\n.!?]/)[0]?.trim() || normalized;
	if (sentence.length <= maxLength) return sentence;
	return `${sentence.slice(0, maxLength - 1).trimEnd()}…`;
}

export function buildMissionObjectiveTitle(message: string): string {
	const value = summarizeMissionText(message, 96);
	return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}
