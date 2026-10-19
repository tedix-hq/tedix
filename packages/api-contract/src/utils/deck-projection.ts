import type * as z from "zod";
import {
	classifyDeckCard,
	DecisionEnvelopeSchema,
	type DecisionEnvelope,
	type DeckRoutingPolicy,
} from "../schemas/os-decision-deck";
import type { WorkInteractionInboxRowSchema } from "../schemas/work-interactions";
import type { WorkApprovalInboxRowSchema } from "../schemas/work-approvals";
import type { ApprovalRequest } from "../contracts/tedi-approvals";
import type { DecisionLearningModel } from "../schemas/decision-learning";
import { DecisionCardPresentationSchema } from "../schemas/decision-card-presentation";
import type { DeckCard } from "../schemas/attention";
import { cardIsDue } from "./card-schedule";
import { scoreLearning, type LearningCandidate } from "./decision-learning";

type Request = z.infer<typeof WorkInteractionInboxRowSchema>;
type WorkApproval = z.infer<typeof WorkApprovalInboxRowSchema>;
export type DeckRoutingReceipt = { id: string } & ReturnType<
	typeof classifyDeckCard
>;

export function rankDecision<
	T extends {
		id: string;
		kind: string;
		project: string;
		urgency: string;
		decision: DecisionEnvelope | null;
	},
>(
	row: T,
	model: DecisionLearningModel | undefined,
	now: Date,
	context: Partial<LearningCandidate> = {},
) {
	return model
		? scoreLearning(
				{
					id: row.id,
					classId: row.decision?.classId ?? row.kind,
					projectId: row.project,
					urgency: row.urgency === "now" ? 1 : 0,
					protected: row.decision ? true : row.kind === "approval",
					lessons: row.decision?.lessons.map((l) => ({
						...l,
						classId: row.decision!.classId,
					})),
					...context,
				},
				model,
				now,
			)
		: { score: 0, factors: [], lessonIds: [] };
}

/** All surfaces rank the same context, including cards without an interaction row. */
export function rankDeckCard<
	T extends {
		id: string;
		kind: string;
		project: string;
		urgency: string;
		label: string;
		decision: DecisionEnvelope | null;
	},
>(
	row: T,
	model: DecisionLearningModel | undefined,
	now: Date,
	request?: {
		kind: string;
		dueAt?: string | null;
		metadata?: Record<string, unknown> | null;
	},
) {
	const m = request?.metadata;
	return rankDecision(row, model, now, {
		classId:
			row.decision?.classId ??
			(typeof m?.decisionClass === "string"
				? m.decisionClass
				: (request?.kind ?? row.kind)),
		dueAt: request?.dueAt,
		text: row.label,
		tediId: typeof m?.proposerTediId === "string" ? m.proposerTediId : null,
		source: typeof m?.source === "string" ? m.source : "decision_capture",
		channel: typeof m?.channel === "string" ? m.channel : undefined,
		personIds: typeof m?.personId === "string" ? [m.personId] : [],
	});
}

export function compareDecisionFreshness(
	a: {
		kind?: string;
		dueAt?: string | null;
		requestedAt?: string;
		score?: number;
	},
	b: {
		kind?: string;
		dueAt?: string | null;
		requestedAt?: string;
		score?: number;
	},
	now: Date,
) {
	const due = (value?: string | null) =>
		value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : Infinity;
	const aDue = due(a.dueAt);
	const bDue = due(b.dueAt);
	return (
		Number(aDue < now.getTime()) - Number(bDue < now.getTime()) ||
		Number(b.kind === "approval") - Number(a.kind === "approval") ||
		(b.score ?? 0) - (a.score ?? 0) ||
		(aDue !== bDue ? aDue - bDue : 0) ||
		(Date.parse(b.requestedAt ?? "") || 0) -
			(Date.parse(a.requestedAt ?? "") || 0)
	);
}

/** Pure projection shared by the authenticated headless reader and trusted recipient summaries. */
export function projectDeckCards(input: {
	requests: readonly Request[];
	work: readonly WorkApproval[];
	runtime: readonly ApprovalRequest[];
	model?: DecisionLearningModel;
	now: Date;
	timeZone?: string;
	routing?: DeckRoutingPolicy;
	onRoute?: (route: DeckRoutingReceipt) => void;
}): DeckCard[] {
	const { now, timeZone, model, routing } = input;
	const cards: DeckCard[] = [];
	for (const row of input.requests) {
		const r = row.request;
		const m = r.metadata;
		if (
			row.effectiveState !== "open" ||
			!row.canRespond ||
			!cardIsDue(r, now, timeZone)
		)
			continue;
		if (
			m.schema === "tedix.decision-capture.v1" &&
			typeof m.attention === "object" &&
			m.attention &&
			"kind" in m.attention &&
			m.attention.kind === "fyi"
		)
			continue;
		if (
			m.schema === "tedix.outbound.v1" &&
			["reviewing", "feedback"].includes(String(m.outboundStatus))
		)
			continue;
		const decision =
			DecisionEnvelopeSchema.safeParse(m.decisionDeck).data ?? null;
		const connector =
			typeof m.approvalOperation === "string" &&
			!!m.approvalOperation.trim() &&
			typeof m.approvalTarget === "string" &&
			!!m.approvalTarget.trim();
		const kind = connector
			? "approval"
			: (decision?.kind ??
				(m.schema === "tedix.outbound.v1"
					? "outbound"
					: r.kind === "handoff"
						? "proposal"
						: m.decisionCard
							? "decision"
							: "question"));
		const presentation = DecisionCardPresentationSchema.safeParse(
			m.cardPresentation,
		).data;
		const classId = decision?.classId ?? String(m.decisionClass ?? r.kind);
		const learnedUsefulness = model?.config.enabled
			? model.weights.usefulness.find((w) => w.key === `class:${classId}`)
			: undefined;
		const route = classifyDeckCard(
			{
				kind,
				classId,
				learnedUsefulness,
				effectKnown:
					presentation &&
					"effectStatus" in presentation &&
					presentation.effectStatus === "unknown"
						? false
						: undefined,
				action: decision
					? undefined
					: String(m.approvalOperation ?? `${r.subject ?? ""}\n${r.prompt}`),
				risk: typeof m.riskLevel === "string" ? m.riskLevel : undefined,
				protectedEffects:
					decision?.protectedEffects ??
					(kind === "outbound"
						? ["message"]
						: m.localImport
							? ["consent"]
							: []),
				tasteOrStrategy: decision?.tasteOrStrategy,
				needsPerson: true,
				dueAt: r.dueAt,
			},
			routing,
			now,
		);
		input.onRoute?.({ id: r.id, ...route });
		if (route.destination !== "deck") continue;
		const project = row.workItem?.projectId ?? r.projectId ?? "Unfiled";
		const urgency =
			m.triage &&
			typeof m.triage === "object" &&
			"urgency" in m.triage &&
			m.triage.urgency === "now"
				? "now"
				: "later";

		cards.push({
			id: r.id,
			kind,
			label: r.subject,
			project,
			urgency,
			decision,
			source: `/work?view=deck#card=${r.id}`,
			requestedAt: r.requestedAt,
			dueAt: r.dueAt,
			score: 0,
			interaction: row,
		});
	}
	for (const row of input.work) {
		if (
			row.effectiveStatus !== "pending" ||
			!row.canDecide ||
			!cardIsDue(row.proposal, now, timeZone)
		)
			continue;
		const route = classifyDeckCard(
			{
				kind: "approval",
				classId: `approval.${row.proposal.authorityKey}`,
				action: row.proposal.authorityKey,
				risk: row.workItem.riskLevel,
				needsPerson: true,
			},
			routing,
			now,
		);
		input.onRoute?.({ id: `work-approval:${row.proposal.id}`, ...route });
		if (route.destination !== "deck") continue;
		cards.push({
			id: `work-approval:${row.proposal.id}`,
			kind: "approval",
			label: row.workItem.title,
			project: row.workItem.projectId ?? "Unfiled",
			urgency: "now",
			decision: null,
			source: `/work?view=deck#card=work-approval:${row.proposal.id}`,
			requestedAt: row.proposal.requestedAt,
			dueAt: null,
			score: 0,
			workApproval: row,
		});
	}
	for (const row of input.runtime) {
		if (row.status !== "pending" || !cardIsDue(row, now, timeZone)) continue;
		const route = classifyDeckCard(
			{
				kind: "approval",
				classId: `approval.${row.actionType}`,
				action: `${row.actionType} ${String(row.payload.toolName ?? row.payload.toolId ?? "")}`,
				risk:
					typeof row.payload.riskLevel === "string"
						? row.payload.riskLevel
						: undefined,
				needsPerson: true,
				protectedEffects:
					row.review.intent === "browser_takeover" ? ["consent"] : [],
			},
			routing,
			now,
		);
		input.onRoute?.({ id: `approval:${row.id}`, ...route });
		if (route.destination !== "deck") continue;
		cards.push({
			id: `approval:${row.id}`,
			kind: "approval",
			label: row.description,
			project: "Organization",
			urgency: "now",
			decision: null,
			source: `/work?view=deck#card=approval:${row.id}`,
			requestedAt: row.createdAt,
			dueAt: null,
			score: 0,
			runtimeApproval: row,
		});
	}
	for (const card of cards)
		card.score = rankDeckCard(
			card,
			model,
			now,
			card.interaction?.request,
		).score;
	return cards.sort((a, b) => compareDecisionFreshness(a, b, now));
}
