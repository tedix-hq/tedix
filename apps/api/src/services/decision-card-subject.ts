import { humanReservedActionClasses } from "@tedix/api-contract/utils/approval-policy";

/**
 * Who or what a card's decision affects. A card about someone else's account
 * must name them and never address the reader as the owner ("your account").
 */
export type DecisionCardSubject = {
	name: string;
	/** The reader is the affected party; only a structured subject can say so. */
	isReader: boolean;
	/** Role, access, money and send cards get a code-built subject line. */
	sensitive: boolean;
};

// Role and status words, and the product itself, are never the affected party.
const NOT_A_NAME = new Set(
	"admin admins administrator owner owners member members guest guests viewer editor role roles current view fresh own your my our their the this that team tedix return set move change grant remove revoke give restore keep owner-action".split(
		" ",
	),
);
const NAME = String.raw`([A-Z][\p{L}\p{N}.-]{1,39}(?: [A-Z][\p{L}\p{N}.-]{1,39})?)`;
const RESOURCE = String.raw`(?:membership|account|seat|role|access|permissions?|consent|login)`;
const PATTERNS = [
	new RegExp(String.raw`\b${NAME}(?:'s|’s)? ${RESOURCE}\b`, "gu"),
	new RegExp(
		String.raw`\b(?:access|permissions?|consent|role|membership) for ${NAME}\b`,
		"gu",
	),
];
const SENSITIVE = new Set([
	"access_control",
	"credentials",
	"money",
	"external_message",
	"public_publish",
]);
const CONSENT = /\b(?:authori[sz]e|authori[sz]ation|consent)\b/i;

function structuredSubject(
	metadata: Record<string, unknown>,
): { name: string; isReader: boolean } | null {
	const value = metadata.cardSubject;
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	const name = typeof record.name === "string" ? record.name.trim() : "";
	if (!name || name.length > 60) return null;
	return { name, isReader: record.isReader === true };
}

function namedSubject(text: string): string | null {
	for (const pattern of PATTERNS)
		for (const match of text.matchAll(pattern)) {
			const name = match[1]!.replace(/[.-]+$/, "");
			if (!NOT_A_NAME.has(name.split(" ")[0]!.toLowerCase())) return name;
		}
	return null;
}

/** Structured `metadata.cardSubject` wins; otherwise a named owner of an account or access in the source. */
export function decisionCardSubject(request: {
	subject: string;
	prompt: string;
	metadata: Record<string, unknown>;
}): DecisionCardSubject | null {
	const text = `${request.subject}\n${request.prompt}`;
	const structured = structuredSubject(request.metadata);
	const name = structured?.name ?? namedSubject(text);
	if (!name) return null;
	return {
		name,
		isReader: structured?.isReader ?? false,
		sensitive: humanReservedActionClasses(text).some((id) => SENSITIVE.has(id)),
	};
}

/** The deterministic subject line that opens the context of a sensitive card. */
export function subjectLine(subject: DecisionCardSubject) {
	return subject.isReader
		? "Affects your own account."
		: `Affects ${subject.name}, not you.`;
}

// "Your click" addresses the reader; "your account" makes them the owner.
const OWNED = String.raw`(?:account|access|membership|seat|role|permissions?|login|admin|member|grants?)`;
const READER_AS_OWNER = new RegExp(
	String.raw`\byours\b|\byour(?:\s+[\p{L}-]+){0,2}?\s+${OWNED}\b|\byou(?:'re|’re| are| have| hold| still| own| currently)(?:\s+[\p{L}-]+){0,2}?\s+(?:an?\s+)?${OWNED}\b`,
	"iu",
);

/** Failures when the face hides or misstates who is affected. */
export function subjectIssues(
	face: {
		title: string;
		context?: string;
		body: string;
		recommendation: string;
	},
	subject: DecisionCardSubject | null,
): string[] {
	if (!subject || subject.isReader) return [];
	const issues: string[] = [];
	const named = new RegExp(
		`(?:^|[^\\p{L}])${subject.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^\\p{L}])`,
		"iu",
	);
	if (!named.test(`${face.title} ${face.context ?? ""}`))
		issues.push("subject_missing");
	const lines = [
		face.title,
		face.context ?? "",
		face.body,
		face.recommendation,
	];
	if (
		lines.some((line) =>
			READER_AS_OWNER.test(
				line.replace(subjectLine(subject), "").replace(/\bnot you\b/gi, ""),
			),
		)
	)
		issues.push("subject_not_reader");
	return issues;
}

export function subjectRepair(subject: DecisionCardSubject) {
	return `This card affects ${subject.name}, not the reader. Name ${subject.name} in the title or context. Never write "your", "yours" or "you have" about ${subject.name}'s account, access or role; write "${subject.name}'s" instead.`;
}

/** Reminders and consent asks: a click on the card performs none of the step. */
export function nextStepCard(request: {
	subject: string;
	prompt: string;
	metadata: Record<string, unknown>;
}): "reminder" | "consent" | null {
	const nudge = request.metadata.laneNudge;
	if (nudge && typeof nudge === "object") return "reminder";
	const decision = request.metadata.decisionDeck;
	const effects =
		decision && typeof decision === "object" && "protectedEffects" in decision
			? decision.protectedEffects
			: request.metadata.protectedEffects;
	if (Array.isArray(effects) && effects.includes("consent")) return "consent";
	return CONSENT.test(`${request.subject}\n${request.prompt}`)
		? "consent"
		: null;
}

/** The honest IF YES line for a card whose click performs no step. */
export const NEXT_STEP_BODY = {
	reminder:
		"Only this reminder closes. Do the step itself, then mark the original ask done.",
	consent:
		"Records that you did the step yourself. Nothing is authorized from this card.",
} as const;

const STEP_WORDS =
	/\b(?:authori[sz]e|approve|consent|sign in|log in|click|open|review|confirm|reply|set|change|send)\b/i;

/** The ask or context must say what the reader actually has to do. */
export function nextStepIssues(face: { title: string; context?: string }) {
	return STEP_WORDS.test(`${face.title} ${face.context ?? ""}`)
		? []
		: ["next_step_missing"];
}
