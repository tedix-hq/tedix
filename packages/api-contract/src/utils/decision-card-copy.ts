import copySpec from "../assets/decision-card-copy.v2.json";
import { containsCardSecret } from "./card-secrets";
import { calendarDay } from "./card-schedule";

type CardCopy = {
	title: string;
	body: string;
	recommendation: string;
	stakes?: string;
	context?: string;
	actionLabels?: Record<string, string>;
	generatedAt?: string;
};

const relativeDatePattern =
	/\b(?:today|tomorrow|yesterday|in \d+ days?|\d+ days? ago)\b/gi;
const bareActionTitle =
	/^\s*(?:execute|run|send|approve|reject|allow|deny|confirm|continue|proceed|start|stop|create|update|delete|remove|publish|save|submit|apply|authorize|review|call|use)[\s.!?…]*$/i;

/** Date-only deadlines keep their calendar day; zoned instants keep their time. */
export function formatIsoCardDates(
	text: string,
	options: { locale?: string; timeZone?: string } = {},
): string {
	return text.replace(
		/(?<![\w/-])\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?)?(?![\w/-])/g,
		(value) => {
			const day = value.slice(0, 10);
			const calendar = new Date(`${day}T00:00:00Z`);
			if (
				!Number.isFinite(calendar.getTime()) ||
				calendar.toISOString().slice(0, 10) !== day
			)
				return value;
			const instant = value.length > 10;
			if (
				instant &&
				!/T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
			)
				return value;
			const date = instant ? new Date(value) : calendar;
			if (!Number.isFinite(date.getTime())) return value;
			return new Intl.DateTimeFormat(options.locale ?? "en-US", {
				month: "short",
				day: "numeric",
				year: "numeric",
				timeZone: instant ? options.timeZone : "UTC",
				...(instant ? ({ hour: "numeric", minute: "2-digit" } as const) : {}),
			}).format(date);
		},
	);
}

export function hasRelativeCardDates(text: string): boolean {
	return new RegExp(relativeDatePattern.source, "i").test(text);
}

/** Legacy relative copy needs both a writing date and a matching stored date. Otherwise omit the sentence. */
export function renderCardDateText(
	text: string,
	options: {
		generatedAt?: string;
		dates?: readonly string[];
		now?: Date;
		timeZone?: string;
	} = {},
): string {
	if (!hasRelativeCardDates(text)) return text;
	const dayNumber = (value: string) => {
		const date = new Date(value);
		if (!Number.isFinite(date.getTime())) return NaN;
		return (
			Date.parse(
				/^\d{4}-\d{2}-\d{2}$/.test(value)
					? value
					: calendarDay(date, options.timeZone),
			) / 86_400_000
		);
	};
	const written = dayNumber(options.generatedAt ?? "");
	const today = dayNumber((options.now ?? new Date()).toISOString());
	const dates = new Set(
		(options.dates ?? []).map(dayNumber).filter(Number.isFinite),
	);
	return (text.match(/[^.!?]+[.!?]*/g) ?? [])
		.flatMap((sentence) => {
			let unbound = false;
			const rendered = sentence.replace(relativeDatePattern, (phrase) => {
				const lower = phrase.toLowerCase();
				const offset =
					lower === "today"
						? 0
						: lower === "tomorrow"
							? 1
							: lower === "yesterday"
								? -1
								: Number(lower.match(/\d+/)?.[0]) *
									(lower.endsWith("ago") ? -1 : 1);
				const target = written + offset;
				if (!dates.has(target)) {
					unbound = true;
					return "";
				}
				const days = target - today;
				return days === 0
					? "today"
					: days === 1
						? "tomorrow"
						: days === -1
							? "yesterday"
							: days > 0
								? `in ${days} days`
								: `${-days} days ago`;
			});
			return unbound ? [] : [rendered.trim()];
		})
		.join(" ");
}

export function renderDecisionCardDates<T extends CardCopy>(
	copy: T,
	dates: readonly string[] = [],
	now = new Date(),
	timeZone?: string,
): T {
	const render = (text: string) =>
		formatIsoCardDates(
			renderCardDateText(text, {
				generatedAt: copy.generatedAt,
				dates,
				now,
				timeZone,
			}),
			{ timeZone },
		);
	return {
		...copy,
		title: render(copy.title) || "Review this request?",
		body: render(copy.body) || "Review the source before deciding.",
		recommendation:
			render(copy.recommendation) || "Check the source in Details.",
		...(copy.context
			? { context: render(copy.context) || "Open Details for the source." }
			: {}),
		...(copy.stakes ? { stakes: render(copy.stakes) } : {}),
		...(copy.actionLabels
			? {
					actionLabels: Object.fromEntries(
						Object.entries(copy.actionLabels).flatMap(([id, label]) => {
							const value = render(label);
							return value ? [[id, value]] : [];
						}),
					),
				}
			: {}),
	};
}

const rawIdentifier = new RegExp(copySpec.rawIdentifierPattern, "i");
const listPrefix = new RegExp(copySpec.listPrefixPattern, "i");

/** "Review 07 — Send the draft?" reads as "Send the draft?": list numbers are not part of the ask. */
export function withoutListPrefix(text: string): string {
	const rest = text.replace(listPrefix, "");
	return rest && rest !== text
		? rest.charAt(0).toUpperCase() + rest.slice(1)
		: text;
}
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
	if (bareActionTitle.test(withoutListPrefix(copy.title)))
		issues.push("bare_action_title");
	if (listPrefix.test(copy.title)) issues.push("list_prefix");
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

const recommendationAction = new RegExp(
	copySpec.recommendationActionPattern,
	"iu",
);

/**
 * "Tedix recommends:" must name what to do, then why: "Record it — the
 * deadline is only proposed." A bare fact ("The deadline is only proposed.")
 * fails. Checked when a face is written, so saved faces keep rendering. The
 * action words are English; other reader languages are not checked.
 */
export function recommendationIssues(
	copy: Pick<CardCopy, "recommendation" | "actionLabels">,
	readerLanguage?: string | null,
): string[] {
	if (readerLanguage && !/^en(?:-|$)/i.test(readerLanguage)) return [];
	const text = copy.recommendation.trim();
	const lower = text.toLowerCase();
	const startsWithAction =
		recommendationAction.test(text) ||
		Object.values(copy.actionLabels ?? {}).some(
			(label) => label.trim() && lower.startsWith(label.trim().toLowerCase()),
		);
	if (!startsWithAction) return ["recommendation_action"];
	// The action plus at least a few words of reason.
	if ((text.match(/\p{L}+/gu) ?? []).length < 4)
		return ["recommendation_reason"];
	return [];
}

/** The face labels the consequence "If yes:", so generated bodies must not repeat it. */
function consequenceWithoutIfYes(body: string): string {
	const rest = body.replace(/^\s*(?:If yes[,:]?\s*)+/i, "");
	return rest.charAt(0).toUpperCase() + rest.slice(1);
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
		`If yes: ${consequenceWithoutIfYes(copy.body)}`,
		`${copy.recommendation}${confidence === null ? "" : ` · ${Math.round(confidence * 100)}% sure`}`,
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
		) {
			// A decline never reads as agreement, even if generated copy says so.
			if (
				intent === "reject" &&
				/^(?:yes|ok|okay|approve|accept|confirm)\b/i.test(labels[key]!)
			)
				return fallback;
			return labels[key]!;
		}
	return fallback;
}

const FALLBACK_TITLE = "Review this request?";

/** Headline when no checked story exists: the original request text, never the pending or unavailable placeholder. */
export function decisionCardFallbackTitle(
	label: string | null | undefined,
	limit: number = copySpec.fields.title.maxLength,
): string {
	const plain = withoutListPrefix((label ?? "").replace(/\s+/g, " ").trim());
	if (
		!plain ||
		plain === copySpec.pendingTitle ||
		plain === copySpec.unavailableTitle ||
		bareActionTitle.test(plain) ||
		containsCardSecret(plain)
	)
		return FALLBACK_TITLE;
	if (plain.length <= limit) return plain;
	const cut = plain.slice(0, limit - 1);
	const atWord = cut.lastIndexOf(" ");
	return `${(atWord > limit / 2 ? cut.slice(0, atWord) : cut).replace(/[\s,;:.!?-]+$/, "")}…`;
}

/**
 * Dates, amounts, counts and addresses on a generated face must appear in the
 * card's source; anything else is a fact the copy model invented.
 */
export function unsupportedCopyFacts(
	copy: CardCopy,
	source: string,
	options: { writtenOn?: string } = {},
) {
	const text = [
		copy.title,
		copy.body,
		copy.recommendation,
		copy.stakes ?? "",
		copy.context ?? "",
	].join(" ");
	// Bound email components; consume numeric punctuation once, then trim it
	// without backtracking over an arbitrarily long failed candidate.
	const pattern = /[\w.+-]{1,64}@[\w-]{1,63}\.[\w.]{1,253}|\d[\d.,:/-]*/g;
	const facts: string[] = [];
	for (let match; (match = pattern.exec(text));) {
		let fact = match[0];
		if (!fact.includes("@")) {
			let end = fact.length;
			while (end > 1 && !/\d/.test(fact[end - 1]!)) end--;
			fact = fact.slice(0, end);
			// Trailing punctuation may start the next email's local part.
			pattern.lastIndex = match.index + end;
		}
		facts.push(fact);
	}
	const haystack = source.toLowerCase();
	const bare = haystack.replace(/[,\s]/g, "");
	// A relative date in the source ("tomorrow") may become an absolute date
	// within a week of the day the card was written.
	const written = Date.parse(options.writtenOn ?? "");
	const resolvable = (fact: string) =>
		/^\d{4}-\d{2}-\d{2}$/.test(fact) &&
		Number.isFinite(written) &&
		hasRelativeCardDates(source) &&
		Date.parse(fact) >= written - 86_400_000 &&
		Date.parse(fact) <= written + 8 * 86_400_000;
	return [...new Set(facts)].filter((fact) => {
		const value = fact.toLowerCase();
		return (
			!haystack.includes(value) &&
			!bare.includes(value.replace(/,/g, "")) &&
			!resolvable(fact)
		);
	});
}
