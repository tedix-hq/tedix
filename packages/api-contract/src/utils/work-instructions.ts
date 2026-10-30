/**
 * Text with its negated clauses removed: "never X", "do not X", "no X, Y or
 * Z." Urgency idioms ("do not wait —", "no need to ask,", "without delay,")
 * negate only themselves, so the instruction after them survives.
 */
export function withoutNegatedClauses(text: string): string {
	return plainText(text)
		.replace(urgencyIdiom, " ")
		.replace(negatedClause, " ")
		.replace(negatedList, " ");
}

/**
 * Compatibility-folded text with zero-width characters removed, so look-alike
 * letters, full-width forms and invisible joins cannot hide a verb.
 */
function plainText(text: string): string {
	return text
		.normalize("NFKC")
		.replace(/[​-‍⁠﻿­]/g, "")
		.replace(/[  -   　]/g, " ")
		.replace(/[‐-―−]/g, (dash) => (dash === "—" || dash === "―" ? " — " : "-"));
}

// "Do not wait —", "don't hesitate,", "no need to ask;", "without delay:",
// "not a drill:", "it is not optional —". The negation covers only the idiom.
const negation = String.raw`\b(?:never|do not|don't|does not|doesn't|must not|cannot|can't|won't|without|not|nicht|ohne)\b`;
const urgencyIdiom = new RegExp(
	String.raw`(?:${negation}|\b(?:no|kein(?:e|en)?)\b)[ \t]+(?:(?:even|further|a|an|the|any|more|longer)[ \t]+){0,2}(?:(?:forget|hesitate|fail|wait|bother|need|neglect)[ \t]+to\b|(?:wait(?:ing)?|hesitat\w*|delay\w*|stall\w*|paus\w*|ask\w*|forget\w*|worr\w*|bother\w*|hold[ \t]+(?:back|off)|stop\w*|drill|optional|negotiable|now|say[ \t]+no|questions?[ \t]+asked|discussion|excuses?|confirmation|approval[ \t]+needed|need[ \t]+to[ \t]+(?:ask|wait|check|confirm)|(?:[\w-]+[ \t]+)?(?:needed|required|necessary)|rush|hurry|just|merely|only|simply|zögern|warten|fragen|(?:r[üu]ck)?frage|verz[öo]gerung)\b(?:[ \t]+(?:for|on|about|with|um|auf|zu)\b)?[^,;:.!?\n—]*[,;:—]?)`,
	"gi",
);

const negatedClause = new RegExp(
	String.raw`(?:${negation}|\b(?:niemals|nie|kein(?:e|en|er|es)?)\b)[^.;!?\n]*`,
	"gi",
);

// "No submission, external sending, consent, payment or publication." A list
// of at least two short items, or one item that "is authorised" or names
// "changes", is a prohibition; "No rush, pay the invoice" stays an instruction.
const listItem = String.raw`[\w/'’-]+(?:[ \t]+[\w/'’-]+){0,6}`;
const negatedList = new RegExp(
	String.raw`\bno[ \t]+(?!(?:problem|problems|worries|rush|hurry|need|doubt|wait|way|matter|pressure|question|questions|one|longer|more)\b)(?:${listItem}(?:[ \t]*(?:,|\bor\b|\band\b|\bnor\b)[ \t]*${listItem})+|${listItem}[ \t]+(?:is|are)[ \t]+(?:authori[sz]ed|allowed|permitted|needed|required)|(?:[\w/'’-]+[ \t]+){0,3}(?:changes?|writes?|edits?|effects?))(?=[ \t]*(?:[.;!?\n]|$))`,
	"gi",
);
