/**
 * Distill a person's replies in one learning-feed scope into durable rules.
 *
 * Quotes of past replies rarely change how a later session behaves; a rule
 * the person keeps restating does. The model sees the scope's replies
 * numbered newest first and must cite, for every rule, the replies that state
 * it. A rule survives only when its cited replies come from at least two
 * sessions, or one cited reply states it as standing ("always", "never",
 * "from now on"), and the cited replies share its words. One-off task
 * instructions, meta/test prompts, names and money never become rules. When
 * replies conflict the newest wins. A failure returns null and the miner
 * keeps the quoted lesson.
 */

const DISTILL_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const DISTILL_TIMEOUT_MS = 25_000;
const MAX_RULES = 8;
const MAX_REPLIES = 120;
const REPLY_CHARS = 280;
const RULE_CHARS = 160;

export interface DistillReply {
	text: string;
	/** Session (thread) the reply came from. */
	session: string | null;
	/** Coarse reply class, when known (prioritizes telling replies). */
	kind?: string;
	occurredAt: string;
}

export interface DistillInput {
	/** The quoted lesson the miner built (header line, then `- ` lines). */
	content: string;
	scope: { repo: string; harness: string; topic: string };
	/** The scope's replies; the quoted lesson is used when absent. */
	replies?: DistillReply[];
}

/** Rules to deliver; `[]` when nothing lasting was found; null on failure. */
export type LessonDistiller = (input: DistillInput) => Promise<string[] | null>;

/**
 * Bumped when the prompt or filter changes, so lessons distilled by an
 * earlier version are rewritten once.
 */
export const DISTILL_VERSION = 5;

/** Test and harness prompts about Tedix itself teach nothing about the person. */
const META_REPLY =
	/\b(without (?:using )?tools|report only|reply (?:only )?with|respond only|say only|tedix context received|this is a test|test message)\b/i;
const STANDING =
	/\b(always|never|from now on|every time|in general|by default|we (?:do not|don't|dont)|stop (?:doing|asking|using)|do not ever|going forward)\b/i;
const MONEY =
	/(?:[€$£]\s?\d|\d[\d.,]*\s?(?:€|eur|usd|dollars?|euros?)\b|\b(?:invoice|payment|salary|bank|iban|tax)\b)/i;

/**
 * Reply kinds (the importer's coarse reply class) that most often state a
 * preference; the rest fill what room is left.
 */
const TELLING_KINDS = new Set([
	"correction",
	"frustration",
	"challenge",
	"plain-english",
	"simplify",
	"verify",
	"ship",
	"fan-out",
	"instruction",
]);

/** Replies worth distilling, newest first, without meta prompts. */
export function distillReplies(
	replies: DistillReply[],
	limit = MAX_REPLIES,
): DistillReply[] {
	const usable = replies.filter(
		(reply) => reply.text.trim() && !META_REPLY.test(reply.text),
	);
	const telling = usable.filter(
		(reply) => !reply.kind || TELLING_KINDS.has(reply.kind),
	);
	const rest = usable.filter(
		(reply) => reply.kind && !TELLING_KINDS.has(reply.kind),
	);
	const byNewest = (a: DistillReply, b: DistillReply) =>
		b.occurredAt.localeCompare(a.occurredAt);
	return [...telling.sort(byNewest), ...rest.sort(byNewest)]
		.slice(0, limit)
		.sort(byNewest)
		.map((reply) => ({
			...reply,
			text: reply.text.replace(/\s+/g, " ").trim().slice(0, REPLY_CHARS),
		}));
}

export function distillPrompt(
	input: DistillInput,
	replies: DistillReply[] = distillReplies(input.replies ?? []),
): string {
	const body = replies.length
		? replies.map((reply, index) => `[${index + 1}] ${reply.text}`).join("\n")
		: input.content;
	// No example rules: a model copies examples into answers they do not fit.
	return [
		"Below are replies a person gave to their AI coding or work agent, numbered newest first.",
		`Write at most ${MAX_RULES} durable rules the agent should follow in every future session, in short imperative plain English.`,
		"A rule must be a general working preference, standing decision, naming convention or recurring correction that the replies state. It must hold beyond the task at hand.",
		"Never write a rule for a one-off task instruction (a specific setting, value, connector, file, person, ID or command to use once), a question, an approval or a status check.",
		"When replies conflict, keep only what the newest reply says.",
		"Do not mention people's names, emails, money, amounts or secrets.",
		"Start each rule with '- ' and end it with the numbers of the replies that state it in square brackets, like: - <rule> [2, 9]",
		"If there is no such rule, answer exactly NONE.",
		"",
		body,
	].join("\n");
}

const STOPWORDS = new Set(
	"always never avoid prefer instead about after before every their there these those would should could which while where when what with without into from that this them they then than your yours just only also keep make sure dont don't does using used rule rules".split(
		" ",
	),
);

function words(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((word) => word.length >= 4 && !STOPWORDS.has(word));
}

/**
 * A rule survives only when the given text shares at least two of its content
 * words (one for a one-word rule), so an invented rule is dropped.
 */
export function supportedRules(rules: string[], quoted: string): string[] {
	const source = new Set(words(quoted));
	return rules.filter((rule) => {
		const own = [...new Set(words(rule))];
		const shared = own.filter((word) =>
			[...source].some(
				(seen) => seen.startsWith(word.slice(0, 5)) || word.startsWith(seen),
			),
		).length;
		return shared >= Math.min(2, own.length) && own.length > 0;
	});
}

export interface CitedRule {
	rule: string;
	cites: number[];
}

/** Parse `- rule [1, 4]` lines; `[]` for NONE; null when unusable. */
export function parseCitedRules(text: string): CitedRule[] | null {
	const trimmed = text.trim();
	if (!trimmed) return null;
	if (/^none\.?$/i.test(trimmed)) return [];
	const rules = trimmed
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => /^(?:[-*•]|\d{1,2}[.)])\s+\S/.test(line))
		.map((line) => {
			const body = line
				.replace(/^(?:[-*•]|\d{1,2}[.)])\s+/, "")
				.replace(/\*\*/g, "");
			const match = /[[(](?:replies?:?\s*)?([\d,\s]+)[\])]\s*\.?$/i.exec(body);
			const cites = match
				? [
						...new Set(
							match[1]!
								.split(",")
								.map((n) => Number(n.trim()))
								.filter((n) => Number.isInteger(n) && n > 0),
						),
					]
				: [];
			const rule = (match ? body.slice(0, match.index) : body)
				.trim()
				.replace(/\s+/g, " ");
			return { rule, cites };
		})
		.filter(({ rule }) => rule.length >= 8 && !/^none\b/i.test(rule));
	if (rules.length === 0) return /\bnone\b/i.test(trimmed) ? [] : null;
	return rules;
}

/** Keep a rule only when its cited replies support it as lasting. */
export function acceptedRules(
	cited: CitedRule[],
	replies: DistillReply[],
): string[] {
	const accepted: string[] = [];
	for (const { rule, cites } of cited) {
		if (MONEY.test(rule)) continue;
		const sources = cites
			.map((n) => replies[n - 1])
			.filter((reply): reply is DistillReply => reply !== undefined);
		if (sources.length === 0) continue;
		const sessions = new Set(
			sources.map((reply) => reply.session ?? reply.text),
		);
		const lasting =
			sessions.size >= 2 || sources.some((reply) => STANDING.test(reply.text));
		if (!lasting) continue;
		if (
			supportedRules([rule], sources.map((reply) => reply.text).join("\n"))
				.length === 0
		)
			continue;
		if (accepted.some((kept) => kept.toLowerCase() === rule.toLowerCase()))
			continue;
		accepted.push(
			rule.length > RULE_CHARS ? `${rule.slice(0, RULE_CHARS - 1)}…` : rule,
		);
		if (accepted.length >= MAX_RULES) break;
	}
	return accepted;
}

type DistillEnv = Pick<CloudflareEnv, "AI"> & {
	AI_GATEWAY_LLM_ID?: string;
};

/** At most this many model calls per lesson, one per slice of replies. */
const MAX_CHUNKS = 3;

function ruleKey(rule: string): Set<string> {
	return new Set(words(rule));
}

function sameRule(a: string, b: string): boolean {
	const x = ruleKey(a);
	const y = ruleKey(b);
	if (x.size === 0 || y.size === 0) return a.toLowerCase() === b.toLowerCase();
	const shared = [...x].filter((word) => y.has(word)).length;
	return shared / new Set([...x, ...y]).size >= 0.5;
}

/** Rules from several slices, most often found first, without repeats. */
export function mergeRules(slices: string[][]): string[] {
	const merged: Array<{ rule: string; count: number; order: number }> = [];
	slices.forEach((rules, slice) =>
		rules.forEach((rule, index) => {
			const found = merged.find((m) => sameRule(m.rule, rule));
			if (found) found.count++;
			else merged.push({ rule, count: 1, order: slice * 100 + index });
		}),
	);
	return merged
		.sort((a, b) => b.count - a.count || a.order - b.order)
		.slice(0, MAX_RULES)
		.map((m) => m.rule);
}

export function modelLessonDistiller(env: DistillEnv): LessonDistiller {
	const ask = async (
		input: DistillInput,
		replies: DistillReply[],
	): Promise<string[] | null> => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const call = env.AI.run(
				DISTILL_MODEL as keyof AiModels,
				{
					messages: [{ role: "user", content: distillPrompt(input, replies) }],
					max_tokens: 500,
					temperature: 0,
				} as never,
				env.AI_GATEWAY_LLM_ID
					? {
							gateway: {
								id: env.AI_GATEWAY_LLM_ID,
								metadata: { surface: "learning-feed-distill" },
							},
						}
					: undefined,
			) as Promise<unknown>;
			call.catch(() => undefined);
			const outcome = await Promise.race([
				call,
				new Promise<"timeout">((resolve) => {
					timer = setTimeout(() => resolve("timeout"), DISTILL_TIMEOUT_MS);
				}),
			]);
			if (outcome === "timeout") return null;
			const response = (outcome as { response?: unknown } | null)?.response;
			if (typeof response !== "string") return null;
			const cited = parseCitedRules(response);
			return cited ? acceptedRules(cited, replies) : null;
		} catch {
			return null;
		} finally {
			clearTimeout(timer);
		}
	};
	return async (input) => {
		// Up to three slices of the scope's history, read in parallel, so a
		// long history is learned whole instead of only its newest replies.
		const all = distillReplies(input.replies ?? [], MAX_REPLIES * MAX_CHUNKS);
		if (all.length === 0) return null;
		const slices: DistillReply[][] = [];
		for (let i = 0; i < all.length; i += MAX_REPLIES)
			slices.push(all.slice(i, i + MAX_REPLIES));
		const answers = await Promise.all(slices.map((slice) => ask(input, slice)));
		const usable = answers.filter((rules): rules is string[] => rules !== null);
		if (usable.length === 0) return null;
		return mergeRules(usable);
	};
}
