import { currentDeckCuration, isCriticalDeckCard } from "./deck-curator";
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
import { deckAsk } from "./deck-ask";
import {
	compareDeckPriority,
	deckPriority,
	type DeckPriorityInput,
} from "./deck-priority";
import type { DeckPriority } from "../schemas/deck-priority";
import { credentialCard } from "./card-secrets";
import { isCommitmentReminder } from "./commitment-reminder";
import { humanOnlyAskReasons } from "./human-only-ask";
import { rowReviewSpec } from "./row-review";
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
	const ranked = rankDecision(row, model, now, {
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
	const state = currentDeckCuration(m);
	const penalty =
		state &&
		!isCriticalDeckCard({
			...row,
			interaction: request
				? ({ request } as DeckCard["interaction"])
				: undefined,
		})
			? state.penalty
			: 0;
	return { ...ranked, score: ranked.score + penalty };
}

function rankedNoise(card: { interaction?: DeckCard["interaction"] }) {
	const state = currentDeckCuration(card.interaction?.request?.metadata);
	return Boolean(state && state.status === "open" && state.penalty < 0);
}

type FreshnessInput = {
	id?: string;
	kind?: string;
	label?: string;
	dueAt?: string | null;
	deadline?: string | null;
	actionable?: boolean;
	blocksCount?: number;
	blocksScore?: number;
	objective?: DeckCard["objective"];
	handled?: boolean;
	expired?: boolean;
	requestedAt?: string;
	score?: number;
	priority?: DeckPriority;
	decision?: DeckCard["decision"];
	interaction?: DeckCard["interaction"];
	workApproval?: DeckCard["workApproval"];
	runtimeApproval?: DeckCard["runtimeApproval"];
	factory?: { policyCritical?: boolean; score?: number };
};

function moneyEffect(card: FreshnessInput) {
	const effects = card.interaction?.request.metadata.protectedEffects;
	return (
		Boolean(card.decision?.protectedEffects.includes("money")) ||
		(Array.isArray(effects) && effects.includes("money"))
	);
}

/** The priority inputs a projected card carries, from its ask and its Work. */
export function deckCardPriorityInput(
	card: FreshnessInput,
	critical: boolean,
): DeckPriorityInput {
	const work = card.interaction?.sourceWork;
	const approvalWork = card.workApproval?.workItem;
	const metadataRisk = card.interaction?.request.metadata.riskLevel;
	const runtimeRisk = card.runtimeApproval?.payload.riskLevel;
	return {
		deadline: card.deadline ?? card.dueAt,
		workDeadline:
			work?.deadline ??
			work?.dueDate ??
			approvalWork?.deadline ??
			approvalWork?.dueDate,
		blocks: Math.max(
			card.blocksScore ?? 0,
			card.blocksCount ?? 0,
			work?.blocksCount ?? 0,
		),
		blocksRunning: work?.blocksRunning,
		costs: moneyEffect(card),
		riskLevel:
			work?.riskLevel ??
			approvalWork?.riskLevel ??
			(typeof metadataRisk === "string"
				? metadataRisk
				: typeof runtimeRisk === "string"
					? runtimeRisk
					: null),
		critical,
		objective: card.objective,
		requestedAt: card.requestedAt,
		factoryScore: card.factory?.score,
		learnedScore: card.score,
	};
}

/** Sets the shared priority on every card; call again after blocked counts change. */
export function applyDeckPriority<T extends FreshnessInput>(
	cards: T[],
	now: Date,
	timeZone?: string,
): T[] {
	for (const card of cards)
		card.priority = deckPriority(
			deckCardPriorityInput(card, isCriticalDeckCard(card)),
			now,
			timeZone,
		);
	return cards;
}

/**
 * Settled asks go last; the rest order by band (Today, This week, Whenever),
 * then the shared priority score. The curator's NOISE label, the learned
 * score, the deadline and age only break ties.
 */
export function compareDecisionFreshness(
	a: FreshnessInput,
	b: FreshnessInput,
	now: Date,
	timeZone?: string,
	priorityOf: (card: FreshnessInput) => DeckPriority = (card) =>
		card.priority ??
		deckPriority(
			deckCardPriorityInput(card, isCriticalDeckCard(card)),
			now,
			timeZone,
		),
) {
	const due = (value?: string | null) =>
		value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : Infinity;
	const aDue = due(a.deadline ?? a.dueAt);
	const bDue = due(b.deadline ?? b.dueAt);
	// Handled or expired asks wait for retirement at the end, never as overdue.
	const aSettled = Boolean(a.handled || a.expired || a.actionable === false);
	const bSettled = Boolean(b.handled || b.expired || b.actionable === false);
	return (
		Number(aSettled) - Number(bSettled) ||
		compareDeckPriority(priorityOf(a), priorityOf(b)) ||
		// Then the ranker's label: a card it called NOISE follows the rest.
		Number(rankedNoise(a)) - Number(rankedNoise(b)) ||
		(b.score ?? 0) - (a.score ?? 0) ||
		(aDue !== bDue ? aDue - bDue : 0) ||
		(Date.parse(b.requestedAt ?? "") || 0) -
			(Date.parse(a.requestedAt ?? "") || 0)
	);
}

/** Sets askKind, deadline, overdue and draftedNotSent on every projected card. */
export function annotateDeckAsk(
	cards: DeckCard[],
	now: Date,
	options: Parameters<typeof deckAsk>[2] = {},
) {
	for (const card of cards)
		Object.assign(
			card,
			deckAsk(
				{
					...card,
					request: card.interaction?.request,
					workItem: card.interaction?.workItem,
				},
				now,
				options,
			),
		);
	return cards;
}

/** The Deck kind of a work interaction, from its typed metadata. */
export function deckInteractionKind(
	requestKind: string,
	m: Record<string, unknown>,
) {
	const decision = DecisionEnvelopeSchema.safeParse(m.decisionDeck).data;
	const connector =
		typeof m.approvalOperation === "string" &&
		!!m.approvalOperation.trim() &&
		typeof m.approvalTarget === "string" &&
		!!m.approvalTarget.trim();
	return connector
		? "approval"
		: (decision?.kind ??
				(m.schema === "tedix.outbound.v1"
					? "outbound"
					: requestKind === "handoff"
						? "proposal"
						: m.decisionCard
							? "decision"
							: "question"));
}

const PERSON_ASK_KINDS = new Set(["question", "input", "handoff"]);

/**
 * One request's routing inputs, shared by the projection and absence
 * explanations. A question, input or handoff asked of a person never routes to
 * the Feed: nothing settles a request there, so it would sit open and unseen.
 * `heldFrom` names the Feed reason it overrode; the sweep withdraws an ask the
 * person taught is not worth their time (`learned_feed`) instead of hiding it.
 */
export function interactionDeckRoute(
	r: {
		kind: string;
		subject: string;
		prompt: string;
		dueAt: string | null;
		/** Who is asked: `requestedFromType` on API rows, `targetType` on D1 rows. */
		requestedFromType?: string | null;
		targetType?: string | null;
		metadata: Record<string, unknown>;
	},
	model: DecisionLearningModel | undefined,
	routing: DeckRoutingPolicy | undefined,
	now: Date,
) {
	const m = r.metadata;
	const decision =
		DecisionEnvelopeSchema.safeParse(m.decisionDeck).data ?? null;
	const kind = deckInteractionKind(r.kind, m);
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
			// A credential ask stays protected whatever generated copy says, and
			// so does an envelope-less ask whose subject names an owner-only act.
			risk:
				credentialCard(`${r.subject ?? ""} ${r.prompt}`, m) ||
				(!decision &&
					kind !== "approval" &&
					humanOnlyAskReasons(r.subject ?? "", routing).length > 0)
					? "critical"
					: typeof m.riskLevel === "string"
						? m.riskLevel
						: undefined,
			protectedEffects:
				decision?.protectedEffects ??
				(kind === "outbound" ? ["message"] : m.localImport ? ["consent"] : []),
			tasteOrStrategy: decision?.tasteOrStrategy,
			needsPerson: true,
			dueAt: r.dueAt,
		},
		routing,
		now,
	);
	if (
		route.destination === "feed" &&
		(r.requestedFromType ?? r.targetType) === "user" &&
		PERSON_ASK_KINDS.has(r.kind)
	)
		return {
			decision,
			kind,
			route: { ...route, destination: "deck" as const, reason: "person_ask" },
			heldFrom: route.reason,
		};
	return { decision, kind, route, heldFrom: null };
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
	destination?: "deck" | "all";
	staleDraftHours?: number;
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
		// Automatic follow-up reminders are listed apart, never as decisions.
		if (isCommitmentReminder(m)) continue;
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
		const { decision, kind, route } = interactionDeckRoute(
			r,
			model,
			routing,
			now,
		);
		input.onRoute?.({ id: r.id, ...route });
		if (route.destination !== "deck" && input.destination !== "all") continue;
		const project = row.workItem?.projectId ?? r.projectId ?? "Unfiled";
		const urgency =
			m.triage &&
			typeof m.triage === "object" &&
			"urgency" in m.triage &&
			m.triage.urgency === "now"
				? "now"
				: "later";
		const rowReview = rowReviewSpec(m);

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
			...(rowReview ? { rowReview } : {}),
			interaction: row,
			...(row.objective ? { objective: row.objective } : {}),
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
		if (route.destination !== "deck" && input.destination !== "all") continue;
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
			...(row.objective ? { objective: row.objective } : {}),
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
		if (route.destination !== "deck" && input.destination !== "all") continue;
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
	annotateDeckAsk(cards, now, {
		timeZone,
		staleDraftHours: input.staleDraftHours,
	});
	applyDeckPriority(cards, now, timeZone);
	return sortByDecisionFreshness(cards, now, timeZone);
}

type FreshnessCard = Parameters<typeof compareDecisionFreshness>[0];

/** Sorts in place, computing each card's critical policy and priority once, not per comparison. */
export function sortByDecisionFreshness<T extends FreshnessCard>(
	cards: T[],
	now: Date,
	timeZone?: string,
): T[] {
	const priorities = new Map<FreshnessCard, DeckPriority>();
	for (const card of cards)
		priorities.set(
			card,
			card.priority ??
				deckPriority(
					deckCardPriorityInput(card, isCriticalDeckCard(card)),
					now,
					timeZone,
				),
		);
	return cards.sort((a, b) =>
		compareDecisionFreshness(a, b, now, timeZone, (card) =>
			priorities.get(card as T)!,
		),
	);
}
