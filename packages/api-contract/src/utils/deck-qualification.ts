import {
	AttentionOfferedChoicesSchema,
	DeckOwnerTaskSchema,
} from "../schemas/attention";
import {
	DecisionEnvelopeSchema,
	type DecisionEnvelope,
} from "../schemas/os-decision-deck";
import type { DeckPipelineConfig } from "../schemas/deck-pipeline";
import defaults from "../assets/deck-pipeline.v1.json";

type Ask = {
	kind?: string;
	subject?: string;
	prompt?: string;
	metadata?: Record<string, unknown> | null;
	decision?: DecisionEnvelope | null;
};
/** Classification supplies presentation data, never authorization to execute an option. */
export function classifyDeckAsk(
	ask: Ask,
	config: DeckPipelineConfig["qualification"] = defaults.qualification,
) {
	const metadata = ask.metadata ?? {};
	const decision =
		ask.decision ??
		DecisionEnvelopeSchema.safeParse(metadata.decisionDeck).data;
	let ownerTask =
		DeckOwnerTaskSchema.safeParse(metadata.ownerTask).data ?? null;
	const text = `${ask.subject ?? ""}\n${ask.prompt ?? ""}`;
	const task =
		config.enabled &&
		(metadata.ownerTask != null ||
			(!(
				ask.kind === "outbound" ||
				decision?.kind === "outbound" ||
				decision?.protectedEffects.includes("message")
			) &&
				new RegExp(config.ownerPresencePattern, "iu").test(text)));
	if (task && !ownerTask) {
		// Preserve source instructions verbatim. Never invent missing steps or a duration.
		const steps = [
			...(ask.prompt ?? "").matchAll(
				new RegExp(config.ownerStepPattern, "gimu"),
			),
		].map((match) => match[1]);
		const duration = new RegExp(config.durationPattern, "iu").exec(
			ask.subject ?? "",
		);
		ownerTask =
			DeckOwnerTaskSchema.safeParse({
				presence: /\bmfa\b|two.factor/iu.test(text)
					? "mfa"
					: /\bconsent\b/iu.test(text)
						? "consent"
						: "login",
				steps,
				estimatedMinutes: Number(duration?.[1]),
			}).data ?? null;
	}
	const offered = AttentionOfferedChoicesSchema.safeParse(metadata).data;
	const responseOptions = task
		? []
		: (decision?.options.map(({ id, label, consequence }) => ({
				id,
				label,
				body: consequence,
			})) ??
			offered?.decisionCard?.options ??
			offered?.suggestedAnswers?.map((label, i) => ({
				id: `answer-${i}`,
				label,
			})) ??
			(config.enabled &&
			new RegExp(config.yesNoPattern, "iu").test(
				ask.subject?.trim() || ask.prompt?.trim() || "",
			)
				? [
						{ id: "yes", label: "Yes" },
						{ id: "no", label: "No" },
					]
				: []));
	return {
		responseKind: task
			? ("task" as const)
			: responseOptions.length
				? ("choice" as const)
				: ("open" as const),
		responseOptions,
		ownerTask,
	};
}
