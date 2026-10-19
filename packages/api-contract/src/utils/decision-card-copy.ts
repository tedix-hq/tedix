import copySpec from "../assets/decision-card-copy.v2.json";
import { containsCardSecret } from "./card-secrets";

type CardCopy = {
	title: string;
	body: string;
	recommendation: string;
	stakes?: string;
	context?: string;
	actionLabels?: Record<string, string>;
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
		copy.context ?? "",
		...Object.values(copy.actionLabels ?? {}),
	].join(" ");
	if (
		(text.match(/\S+/gu) ?? []).length +
			(copy.context ? copySpec.faceChromeWords : 0) >
		copySpec.faceWordLimit
	)
		issues.push("face_word_limit");
	if (rawIdentifier.test(text)) issues.push("raw_identifier");
	if (new RegExp(copySpec.technicalTextPattern).test(text))
		issues.push("technical_text");
	if (
		Object.values(copy.actionLabels ?? {}).some(
			(label) => (label.match(/\S+/gu) ?? []).length > 4,
		)
	)
		issues.push("action_label_length");
	if (banned.test(text)) issues.push("banned_words");
	if (containsCardSecret(copy)) issues.push("secret");
	if (cardCopyOverlap(copy)) issues.push("overlap");
	return issues;
}

/** One plain-text face for MCP and terminal fallbacks. Source details carry no implied authority. */
export function decisionCardFaceText(
	copy: (CardCopy & { version: number }) | null | undefined,
	confidence: number | null = null,
): string {
	if (
		!copy ||
		copy.version !== 2 ||
		!copy.context ||
		checkDecisionCardCopy(copy).length
	)
		return copySpec.pendingFace;
	return [
		copy.title,
		copy.context,
		`If yes: ${copy.body}`,
		`${copy.recommendation} ${confidence === null ? "Confidence not assessed" : `${Math.round(confidence * 100)}% sure`}`,
		copy.stakes,
		...Object.values(copy.actionLabels ?? {}),
	]
		.filter(Boolean)
		.join("\n");
}

export function decisionCardActionLabel(
	copy: CardCopy | null | undefined,
	id: string,
	intent: string | undefined,
	fallback: string,
): string {
	const labels = copy?.actionLabels;
	for (const key of [id, intent])
		if (
			key &&
			labels &&
			Object.hasOwn(labels, key) &&
			typeof labels[key] === "string"
		)
			return labels[key]!;
	return fallback;
}
