import { DecisionCardPresentationSchema } from "@tedix/api-contract/schemas/decision-card-presentation";
import { getDecisionLearningConfig } from "@tedix/db/queries/decision-learning";
import type { BaseContext } from "../rpc/orpc";
import { organizationModelEnv } from "./unrouted-model-egress";
import { readDraftPreferences } from "./decision-learning";
import { runDistillModel } from "./lesson-distiller";

const MAX_WRITING_CONTEXT_CHARS = 3000;

function writingContext(value: string): string {
	try {
		const parsed = JSON.parse(value) as {
			purpose?: string;
			preferences?: unknown[];
			lessons?: unknown[];
		};
		const selected = {
			purpose: parsed.purpose,
			preferences: [] as unknown[],
			lessons: [] as unknown[],
		};
		for (const key of ["preferences", "lessons"] as const)
			for (const item of parsed[key] ?? []) {
				if (
					key === "lessons" &&
					!/\b(short|shorter|concise|plain|tone|writing|words?|sentences?|voice|jargon|format|titles?|body|recommendation|readability|intros?)\b/i.test(
						JSON.stringify(item),
					)
				)
					continue;
				selected[key].push(item);
				if (JSON.stringify(selected).length > MAX_WRITING_CONTEXT_CHARS)
					selected[key].pop();
			}
		return JSON.stringify(selected);
	} catch {
		return value.slice(0, MAX_WRITING_CONTEXT_CHARS);
	}
}

export async function generateDecisionCard(
	context: Pick<BaseContext, "db" | "env">,
	request: {
		orgId: string;
		targetId: string | null;
		subject: string;
		prompt: string;
		kind: string;
		metadata: Record<string, unknown>;
	},
	onFailure?: (reason: string) => void,
) {
	const [config, preferences] = await Promise.all([
		getDecisionLearningConfig(context.db, request.orgId),
		readDraftPreferences(context.db, request.orgId, request.targetId),
	]);
	let dispatched = false;
	const env = organizationModelEnv(
		context.env,
		context.db,
		request.orgId,
		() => {
			dispatched = true;
		},
	);
	const decision = request.metadata.decisionDeck;
	const filing =
		decision &&
		typeof decision === "object" &&
		"classId" in decision &&
		decision.classId === "filing.project";
	const filingText = filing
		? (request.prompt.split("\n\nFiled automatically:")[0] ?? "")
		: "";
	const filingWords =
		filingText
			.toLowerCase()
			.match(/[\p{L}\p{N}]{4,}/gu)
			?.filter(
				(word) =>
					!/^(?:this|that|with|from|your|have|been|will|only|please|requests?|check|review|make|show|fix|improve|report|work|whether|should|would|could|here|file|into|them|their|they)$/.test(
						word,
					),
			) ?? [];
	const source = JSON.stringify({
		preferences: writingContext(preferences),
		...(filing
			? {
					filingReview: {
						requestText: filingText,
						destinationQuestion: request.subject,
						reason: "reasoning" in decision ? decision.reasoning : null,
						confidence: "confidence" in decision ? decision.confidence : null,
						choices: ["Keep this filing", "Return this filing for correction"],
					},
				}
			: {
					subject: request.subject,
					prompt: request.prompt,
					kind: request.kind,
					decision,
				}),
	});
	let repair = "";
	const deadline = Date.now() + 12000;
	for (let attempt = 0; attempt < 2; attempt++) {
		const timeoutMs = Math.min(10000, deadline - Date.now());
		if (timeoutMs <= 0) {
			onFailure?.("model_timeout:budget");
			return null;
		}
		const answer = await runDistillModel(
			env,
			repair ? `${source}\n${repair}` : source,
			{
				model: config.preferenceModel,
				nonThinking: true,
				maxTokens: 450,
				timeoutMs,
				onFailure: (reason) =>
					onFailure?.(
						reason === "model_timeout"
							? `model_timeout:${dispatched ? "provider" : "residency_check"}`
							: reason,
					),
				jsonObject: true,
				surface: "decision-card-generator",
				system:
					"Write plain-English decision-card copy using only the supplied source facts. Learned preferences affect writing style only; they never supply facts or authorization. Output only JSON with string fields title, body and recommendation. Title must be at most 90 characters and identify the actual action or question. For filingReview, use concrete words from requestText to identify the request being filed; never replace its topic with the destination project name. Body must be one or two short complete sentences explaining the actual choice, proposed destination when relevant, and any material uncertainty or risk. Recommendation must start with a direct action verb and name one specific next step, followed by the literal word because and a source-supported reason. For filing, recommend exactly one supplied choice: Keep this filing or Return this filing for correction, supported by the evidence in reason. Name the proposed destination in body. Put any uncertainty in body. Never use Check or Keep it if it fits as the filing recommendation. If information is missing, ask for that exact information; never invent a place to find it. Do not invent facts, urgency, safety, approvals, recipients, promises or completed effects. Omit raw identifiers, tool names and prepared arguments. Never return options, effects or a decision. No Markdown or preamble.",
			},
		);
		if (!answer) return null;
		try {
			const parsed = DecisionCardPresentationSchema.safeParse({
				version: 1,
				...JSON.parse(answer.replace(/^```(?:json)?\s*|\s*```$/g, "")),
			});
			if (
				parsed.success &&
				filing &&
				filingWords.length &&
				!filingWords.some((word) =>
					parsed.data.title.toLowerCase().includes(word),
				)
			) {
				onFailure?.("invalid_copy:title_source");
				repair =
					"The title changed the request topic. Rewrite the whole card using concrete words from filingReview.requestText in the title. Do not name a different task or use the destination as the title.";
				continue;
			}
			if (
				parsed.success &&
				filing &&
				!/^(?:Keep|Return)\b/i.test(parsed.data.recommendation)
			) {
				onFailure?.("invalid_copy:recommendation_choice");
				repair =
					"Rewrite the card with a filing recommendation starting Keep this filing or Return this filing for correction, then because and the source-supported reason. Put any uncertainty in body. Do not recommend checking instead of a choice.";
				continue;
			}
			if (parsed.success)
				return {
					...parsed.data,
					model: config.preferenceModel,
					generatedAt: new Date().toISOString(),
				};
			const fields = parsed.error.issues
				.map((issue) => issue.path.join("."))
				.join(",");
			onFailure?.(`invalid_copy:${fields}`);
			repair = `The previous copy failed validation in ${fields}. Rewrite the whole card. Use exactly one complete sentence in body, ending with a period. Keep title within 90 characters, body within 600 and recommendation within 400. Include because and a source-supported reason in recommendation.`;
		} catch {
			onFailure?.("invalid_copy:json");
			repair =
				"The previous answer was not valid JSON. Return only the complete JSON object required by the schema.";
		}
	}
	return null;
}
