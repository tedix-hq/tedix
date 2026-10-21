import copySpec from "@tedix/api-contract/assets/decision-card-copy.v2.json";
import { formatIsoCardDates } from "@tedix/api-contract/utils/decision-card-copy";

type Face = {
	title: string;
	body: string;
	recommendation: string;
	context?: string;
	stakes?: string;
};

export type FaceFactGap = {
	check: "context" | "cost_of_waiting" | "option_cost";
	source: string;
};

const ignored = new Set(
	[...copySpec.stopWords, ...copySpec.bannedWords].map((word) =>
		word.toLowerCase(),
	),
);
// Words are matched only in English source text; numbers in any language.
const ENGLISH = /\b(?:the|is|are|will|to|of|and|until|before|your)\b/i;
const TRIVIAL_COST =
	/^(?:none|no cost|nothing|free|n\/a|no proposed action is authori[sz]ed)\.?$/i;
const NUMBER = /\d[\d.,:/-]*\d|\d/g;

function stems(text: string) {
	return (text.toLowerCase().match(/\p{L}{5,}/gu) ?? [])
		.filter((word) => !ignored.has(word))
		.map((word) => word.slice(0, 5));
}

/**
 * A fact with dates or amounts is restated by one of them; otherwise by one
 * distinctive word of the fact.
 */
function restates(fact: string, face: string) {
	const dates = fact.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? [];
	if (dates.length) {
		const shown = formatIsoCardDates(face).toLowerCase();
		return dates.some((date) =>
			shown.includes(formatIsoCardDates(date).toLowerCase()),
		);
	}
	const numbers = fact.match(NUMBER) ?? [];
	if (numbers.length) {
		const bare = face.replace(/,/g, "");
		return numbers.some((number) => bare.includes(number.replace(/,/g, "")));
	}
	const anchors = ENGLISH.test(fact) ? stems(fact) : [];
	if (!anchors.length) return true;
	const shown = new Set(stems(face));
	return anchors.some((stem) => shown.has(stem));
}

function text(value: unknown) {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Decision facts the face must carry so a person can decide without Details:
 * why now (context), what waiting costs, and what saying yes costs. Facts are
 * read from the same decision the writer received; filing reviews pass none.
 */
export function missingDecisionFaceFacts(
	face: Face,
	decision: unknown,
): FaceFactGap[] {
	const gaps: FaceFactGap[] = [];
	if (!text(face.context))
		gaps.push({ check: "context", source: "why this needs attention now" });
	if (!decision || typeof decision !== "object") return gaps;
	const record = decision as Record<string, unknown>;
	const waiting = text(record.costOfWaiting);
	if (waiting && !restates(waiting, [face.context, face.stakes].join(" ")))
		gaps.push({ check: "cost_of_waiting", source: waiting });
	const approve = Array.isArray(record.options)
		? (record.options as Record<string, unknown>[]).find(
				(option) => option?.intent === "approve",
			)
		: undefined;
	const cost = text(approve?.cost);
	if (
		cost &&
		!TRIVIAL_COST.test(cost) &&
		!restates(cost, [face.body, face.stakes, face.context].join(" "))
	)
		gaps.push({ check: "option_cost", source: cost });
	return gaps;
}
