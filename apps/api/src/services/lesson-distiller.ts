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

export function distillPrompt(input: DistillInput): string {
	return [
		"Below are replies a person gave to their AI coding or work agent, each with what the agent had just said.",
		"Write at most 3 durable rules that agent should follow in every future session, in short imperative plain English.",
		"Only write a rule for a lasting preference, standing decision, naming convention or correction the person would repeat (for example: 'Call them tedis, not agents.', 'Answer in short plain English.', 'Commit straight to main; never open pull requests.').",
		"Do not write rules for one-off task requests, questions, approvals or status checks. Do not invent anything the replies do not show. Do not include names of other people, emails, or secrets.",
		"If there is no lasting rule, answer exactly NONE. Otherwise output one rule per line, each starting with '- '.",
		"",
		input.content,
	].join("\n");
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
			return typeof response === "string"
				? parseDistilledRules(response)
				: null;
		} catch {
			return null;
		} finally {
			clearTimeout(timer);
		}
	};
}
