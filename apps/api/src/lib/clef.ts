/**
 * Workers AI Clef decision-model wrapper.
 *
 * Clef (`@cf/cloudflare/clef`, `@cf/cloudflare/clef-flash`) turns a state and
 * a map of typed questions into probabilities. Request, per
 * https://developers.cloudflare.com/workers-ai/models/clef/ (schema-input.json):
 *
 *   { model: "clef" | "clef-flash", state: string | object,
 *     questions: { [id]: { type: "noul", instructions }
 *                       | { type: "choice", instructions, criteria: {opt: desc} } } }
 *
 * Response (schema-output.json):
 *
 *   { model, usage: { input_tokens, output_tokens },
 *     answers: { [id]: { type: "noul", noul: number }
 *                    | { type: "choice", choice, probabilities: {opt: p}, confidence } } }
 *
 * Model failure is an expected outcome here, not an exception: every call is
 * bounded by a timeout and any error, timeout, or malformed answer returns
 * `{ ok: false }` so callers can degrade to a safe default.
 */

export const CLEF_TIMEOUT_MS = 2_500;

export type ClefModelId = "@cf/cloudflare/clef-flash" | "@cf/cloudflare/clef";

export type ClefQuestion =
	| { type: "noul"; instructions: string }
	| {
			type: "choice";
			instructions: string;
			criteria: Record<string, string | null>;
	  };

export type ClefAnswer =
	| { type: "noul"; noul: number }
	| {
			type: "choice";
			choice: string;
			probabilities: Record<string, number>;
			confidence: number;
	  };

export type ClefRunResult =
	| { ok: true; answers: Record<string, ClefAnswer>; latencyMs: number }
	| {
			ok: false;
			reason: "error" | "timeout" | "malformed";
			latencyMs: number;
	  };

type ClefEnv = Pick<CloudflareEnv, "AI" | "AI_GATEWAY_LLM_ID">;

function modelSelector(modelId: ClefModelId): "clef" | "clef-flash" {
	return modelId === "@cf/cloudflare/clef" ? "clef" : "clef-flash";
}

function isProbability(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= 0 &&
		value <= 1
	);
}

function parseAnswer(question: ClefQuestion, raw: unknown): ClefAnswer | null {
	if (!raw || typeof raw !== "object") return null;
	const answer = raw as Record<string, unknown>;
	if (question.type === "noul") {
		return isProbability(answer.noul)
			? { type: "noul", noul: answer.noul }
			: null;
	}
	const probabilities = answer.probabilities;
	if (
		typeof answer.choice !== "string" ||
		!(answer.choice in question.criteria) ||
		!probabilities ||
		typeof probabilities !== "object"
	) {
		return null;
	}
	const parsed: Record<string, number> = {};
	for (const [option, p] of Object.entries(probabilities)) {
		if (!isProbability(p)) return null;
		parsed[option] = p;
	}
	return {
		type: "choice",
		choice: answer.choice,
		probabilities: parsed,
		confidence: isProbability(answer.confidence) ? answer.confidence : 0,
	};
}

/**
 * Run one Clef evaluation. Never throws for model failure.
 *
 * The binding returns the `result` object directly; the REST envelope
 * (`{ result: {...} }`) is unwrapped too so a gateway that passes it through
 * does not read as malformed.
 */
export async function runClef(
	env: ClefEnv,
	input: {
		modelId: ClefModelId;
		state: string | Record<string, unknown>;
		questions: Record<string, ClefQuestion>;
		surface: string;
		timeoutMs?: number;
	},
): Promise<ClefRunResult> {
	const started = Date.now();
	const timeoutMs = input.timeoutMs ?? CLEF_TIMEOUT_MS;
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<"timeout">((resolve) => {
		timer = setTimeout(() => {
			controller.abort();
			resolve("timeout");
		}, timeoutMs);
	});
	try {
		const call = env.AI.run(
			input.modelId as keyof AiModels,
			{
				model: modelSelector(input.modelId),
				state: input.state,
				questions: input.questions,
			} as never,
			{
				signal: controller.signal,
				...(env.AI_GATEWAY_LLM_ID
					? {
							gateway: {
								id: env.AI_GATEWAY_LLM_ID,
								metadata: { surface: input.surface },
							},
						}
					: {}),
			},
		) as Promise<unknown>;
		// A late rejection after the timeout won must not surface as unhandled.
		call.catch(() => undefined);
		const outcome = await Promise.race([call, timeout]);
		const latencyMs = Date.now() - started;
		if (outcome === "timeout")
			return { ok: false, reason: "timeout", latencyMs };

		const envelope = outcome as { answers?: unknown; result?: unknown } | null;
		const body =
			envelope && envelope.answers === undefined && envelope.result
				? (envelope.result as { answers?: unknown })
				: envelope;
		const rawAnswers = body?.answers;
		if (!rawAnswers || typeof rawAnswers !== "object") {
			return { ok: false, reason: "malformed", latencyMs };
		}
		const answers: Record<string, ClefAnswer> = {};
		for (const [id, question] of Object.entries(input.questions)) {
			const answer = parseAnswer(
				question,
				(rawAnswers as Record<string, unknown>)[id],
			);
			if (!answer) return { ok: false, reason: "malformed", latencyMs };
			answers[id] = answer;
		}
		return { ok: true, answers, latencyMs };
	} catch {
		return { ok: false, reason: "error", latencyMs: Date.now() - started };
	} finally {
		clearTimeout(timer);
	}
}
