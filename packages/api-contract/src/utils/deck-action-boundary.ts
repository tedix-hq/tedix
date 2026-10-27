import type { DeckCard } from "../schemas/attention";
import {
	classifyDeckCard,
	DecisionEnvelopeSchema,
} from "../schemas/os-decision-deck";
import { humanReservedActionClasses } from "./approval-policy";

/** System follow-ups carry no authority from the decision they replace. */
export function isFactsChangedReview(request: {
	kind: string;
	creatorType: string;
	creatorId?: string | null;
	metadata: Record<string, unknown>;
}) {
	const m = request.metadata;
	const parsed = DecisionEnvelopeSchema.safeParse(m.decisionDeck);
	return (
		request.kind === "question" &&
		request.creatorType === "system" &&
		request.creatorId === "tedix" &&
		typeof m.replacesDecisionId === "string" &&
		m.replacesDecisionId.length > 0 &&
		!m.protected &&
		m.approvalOperation === undefined &&
		m.schema !== "tedix.outbound.v1" &&
		!m.localImport &&
		(m.riskLevel === undefined ||
			["low", "medium"].includes(String(m.riskLevel))) &&
		(m.protectedEffects === undefined ||
			(Array.isArray(m.protectedEffects) && m.protectedEffects.length === 0)) &&
		(m.reversibility === undefined || m.reversibility === "two_way") &&
		!(
			m.cardPresentation &&
			typeof m.cardPresentation === "object" &&
			"effectStatus" in m.cardPresentation &&
			m.cardPresentation.effectStatus === "unknown"
		) &&
		parsed.success &&
		parsed.data.classId === "decision-facts-changed" &&
		parsed.data.kind === "question" &&
		parsed.data.reversibility === "two_way" &&
		parsed.data.protectedEffects.length === 0 &&
		parsed.data.options.every((option) => !option.effect) &&
		parsed.data.options.some(
			(option) => option.id === "dismiss" && option.intent === "reject",
		)
	);
}

/** Presentation and execution share the same headless action ceiling. */
export function deckResponseRequiresHuman(
	card: DeckCard,
	body: string,
): boolean {
	const request = card.interaction?.request;
	if (!request) return true;
	const metadata = request.metadata;
	const parsed = DecisionEnvelopeSchema.safeParse(metadata.decisionDeck);
	const envelope = parsed.success ? parsed.data : null;
	const classId =
		envelope?.classId ?? String(metadata.decisionClass ?? request.kind);
	const presentation = metadata.cardPresentation;
	const critical =
		classifyDeckCard({
			kind: card.kind,
			classId,
			risk:
				typeof metadata.riskLevel === "string" ? metadata.riskLevel : undefined,
			action: String(
				metadata.approvalOperation ?? `${request.subject}\n${request.prompt}`,
			),
			protectedEffects:
				envelope?.protectedEffects ??
				(card.kind === "outbound"
					? ["message"]
					: metadata.localImport
						? ["consent"]
						: []),
			needsPerson: true,
		}).reason === "critical";
	const reserved = humanReservedActionClasses(
		`${classId}\n${request.subject}\n${request.prompt}\n${envelope?.proposal ?? ""}\n${envelope?.recommendation ?? ""}\n${body}`,
	);
	return Boolean(
		critical ||
		reserved.length ||
		request.kind === "handoff" ||
		["outbound", "approval"].includes(card.kind) ||
		metadata.approvalOperation !== undefined ||
		Boolean(metadata.localImport) ||
		(metadata.riskLevel !== undefined &&
			!["low", "medium"].includes(String(metadata.riskLevel))) ||
		(metadata.protectedEffects !== undefined &&
			(!Array.isArray(metadata.protectedEffects) ||
				metadata.protectedEffects.length > 0)) ||
		(metadata.reversibility !== undefined &&
			metadata.reversibility !== "two_way") ||
		(metadata.decisionDeck !== undefined && !parsed.success) ||
		(presentation &&
			typeof presentation === "object" &&
			!Array.isArray(presentation) &&
			presentation.effectStatus === "unknown") ||
		(envelope &&
			(envelope.reversibility !== "two_way" ||
				envelope.protectedEffects.length > 0 ||
				envelope.options.some((option) => option.effect))),
	);
}
