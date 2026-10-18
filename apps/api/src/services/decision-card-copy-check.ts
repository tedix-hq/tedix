import copySpec from "@tedix/api-contract/assets/decision-card-copy.v2.json";

type CardCopy = {
	title: string;
	body: string;
	recommendation: string;
	stakes?: string;
};
const rawIdentifier = new RegExp(copySpec.rawIdentifierPattern, "i");
const banned = new RegExp(`\\b(?:${copySpec.bannedWords.join("|")})\\b`, "i");
const stopWords = new Set(copySpec.stopWords);

function words(text: string) {
	return new Set(
		(text.toLowerCase().match(/[a-z]+/g) ?? []).filter(
			(word) => !stopWords.has(word),
		),
	);
}

/** Dice similarity catches shared phrasing while allowing necessary subject names. */
function cardCopyOverlap(copy: CardCopy) {
	const fields = [copy.title, copy.body, copy.recommendation].map(words);
	return fields.some((left, i) =>
		fields.slice(i + 1).some((right) => {
			const shared = [...left].filter((word) => right.has(word)).length;
			return (
				left.size + right.size > 0 &&
				(2 * shared) / (left.size + right.size) >= copySpec.overlapThreshold
			);
		}),
	);
}

export function checkDecisionCardCopy(copy: CardCopy) {
	const issues: string[] = [];
	for (const [field, rule] of Object.entries(copySpec.fields)) {
		const text = copy[field as keyof typeof copySpec.fields];
		if (!text.trim() || text.length > rule.maxLength || /[\r\n]/.test(text))
			issues.push(field);
	}
	if (!copy.title.endsWith("?")) issues.push("ask_question");
	const text = [
		copy.title,
		copy.body,
		copy.recommendation,
		copy.stakes ?? "",
	].join(" ");
	if (rawIdentifier.test(text)) issues.push("raw_identifier");
	if (banned.test(text)) issues.push("banned_words");
	if (cardCopyOverlap(copy)) issues.push("overlap");
	return issues;
}
