/**
 * Distill a learning-feed lesson's quoted decisions into durable rules.
 *
 * The miner groups a person's replies to their agents by scope and quotes
 * them. Quotes of one-off requests do not change how a later session
 * behaves; a rule such as "Call them tedis, not agents" or "Commit straight
 * to main; never open pull requests" does. This asks a text model for at
 * most three such rules, or none when the replies carry no lasting
 * preference, decision or recurring correction. A failure returns null and
 * the miner keeps the quoted lesson.
 */

const DISTILL_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const DISTILL_TIMEOUT_MS = 8_000;
const MAX_RULES = 3;
const RULE_CHARS = 220;

export interface DistillInput {
	/** The quoted lesson the miner built (header line, then `- ` lines). */
	content: string;
	scope: { repo: string; harness: string; topic: string };
}

/** Rules to deliver; `[]` when nothing lasting was found; null on failure. */
export type LessonDistiller = (input: DistillInput) => Promise<string[] | null>;

/**
 * Bumped when the prompt or filter changes, so lessons distilled by an
 * earlier version are rewritten once.
 */
export const DISTILL_VERSION = 2;

export function distillPrompt(input: DistillInput): string {
	// No example rules: a model copies examples into answers they do not fit.
	return [
		"Below are replies a person gave to their AI coding or work agent, each with what the agent had just said.",
		"Write at most 3 durable rules that agent should follow in every future session, in short imperative plain English.",
		"Only write a rule for a lasting preference, standing decision, naming convention or correction that one of the replies below states in its own words. Each rule must restate what a reply says; never add a rule the replies do not state.",
		"Do not write rules for one-off task requests, questions, approvals or status checks. Do not include names of other people, emails, or secrets.",
		"If there is no lasting rule, answer exactly NONE. Otherwise output one rule per line, each starting with '- '.",
		"",
		input.content,
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
 * A rule survives only when the quoted replies share at least two of its
 * content words (one for a one-word rule), so an invented rule is dropped.
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

/** Parse the model's answer into rules; null when it is unusable. */
export function parseDistilledRules(text: string): string[] | null {
	const trimmed = text.trim();
	if (!trimmed) return null;
	if (/^none\.?$/i.test(trimmed)) return [];
	const rules = trimmed
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => /^[-*•]\s+\S/.test(line))
		.map((line) => line.replace(/^[-*•]\s+/, "").trim())
		.filter((rule) => rule.length >= 8 && !/^none\b/i.test(rule))
		.map((rule) =>
			rule.length > RULE_CHARS ? `${rule.slice(0, RULE_CHARS - 1)}…` : rule,
		)
		.slice(0, MAX_RULES);
	if (rules.length === 0) return /\bnone\b/i.test(trimmed) ? [] : null;
	return rules;
}

type DistillEnv = Pick<CloudflareEnv, "AI"> & {
	AI_GATEWAY_LLM_ID?: string;
};

export function modelLessonDistiller(env: DistillEnv): LessonDistiller {
	return async (input) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const call = env.AI.run(
				DISTILL_MODEL as keyof AiModels,
				{
					messages: [{ role: "user", content: distillPrompt(input) }],
					max_tokens: 300,
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
			const rules = parseDistilledRules(response);
			return rules ? supportedRules(rules, input.content) : null;
		} catch {
			return null;
		} finally {
			clearTimeout(timer);
		}
	};
}
